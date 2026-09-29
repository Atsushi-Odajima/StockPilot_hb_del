import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import type { AppConfig } from './config.js';
import type { Db } from './db/pool.js';
import type { Storage } from './storage.js';
import { AppError, fail } from './errors.js';
import type { Ctx } from './services/context.js';
import { lookupCommand } from './services/context.js';
import * as auth from './services/auth.js';
import * as masters from './services/masters.js';
import * as inv from './services/inventory.js';
import * as po from './services/po.js';
import * as rep from './services/replenish.js';
import * as st from './services/stocktake.js';
import * as q from './services/queries.js';
import * as docs from './services/documents.js';
import * as csv from './services/csv.js';
import * as exp from './services/exports.js';
import * as backup from './services/backup.js';
import { createSampleWorkspace } from './services/sample.js';
import * as S from '../shared/schemas.js';
import { CSV_MAX_BYTES, PHOTO_MAX_BYTES, BACKUP_MAX_BYTES } from '../shared/limits.js';

const COOKIE = 'sp_session';
const CSRF_HEADER = 'x-stockpilot-csrf';

declare module 'fastify' {
  interface FastifyRequest {
    session?: auth.SessionInfo;
    ctx?: Ctx;
  }
}

export interface AppDeps {
  config: AppConfig;
  db: Db;
  storage: Storage;
  now?: () => Date;
  mailer?: (to: string, subject: string, body: string) => Promise<void>;
}

const idParam = z.object({ id: z.string().uuid() });
const pageQ = z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).max(1_000_000).optional() });

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, storage } = deps;
  const now = deps.now ?? (() => new Date());
  const app = Fastify({
    logger: config.env === 'test' ? false : { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'] },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
    disableRequestLogging: config.env !== 'development',
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.env === 'production' ? { maxAge: 15552000, includeSubDomains: true } : false,
  });
  await app.register(rateLimit, { global: true, max: Number(process.env.RATE_LIMIT_PER_MIN ?? 600), timeWindow: '1 minute', errorResponseBuilder: () => ({ statusCode: 429, error: { code: 'RATE_LIMITED', message: '操作が多すぎます。少し待ってから再度お試しください。' } }) });
  await app.register(multipart, { limits: { fileSize: BACKUP_MAX_BYTES, files: 1, fields: 10 } });

  // ---------- 共通：エラー応答 ----------
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: err.issues[0]?.message ? `入力内容を確認してください：${err.issues[0].message}` : '入力内容を確認してください',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode === 429) return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: '操作が多すぎます。少し待ってから再度お試しください。' } });
    if (e.code === 'FST_REQ_FILE_TOO_LARGE' || e.statusCode === 413) return reply.status(413).send({ error: { code: 'TOO_LARGE', message: 'ファイルが大きすぎます' } });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: { code: 'VALIDATION', message: '要求を処理できませんでした' } });
    req.log.error({ err: { message: e.message, code: e.code } }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'サーバーで問題が発生しました。操作が反映されたか分からない場合は、処理状況を確認してから再送してください。' } });
  });

  // ---------- 共通：CSRF（状態変更要求は独自ヘッダー＋Origin 一致を要求） ----------
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (req.headers[CSRF_HEADER] !== '1') fail('CSRF', '不正な要求です（ページを再読み込みしてください）');
    const origin = req.headers.origin;
    if (origin && origin !== config.publicOrigin) fail('CSRF', '不正な送信元からの要求です');
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  const setSessionCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.env === 'production',
      maxAge: config.sessionTtlDays * 86400,
    });

  // ---------- 認証 ----------
  const authed = async (req: FastifyRequest) => {
    const s = await auth.resolveSession(db, req.cookies[COOKIE]);
    if (!s) fail('UNAUTHENTICATED', 'ログインが必要です（セッションの期限切れ）');
    if (!s!.wsId) fail('STATE', 'サンプルが未作成です');
    req.session = s!;
    req.ctx = { db, storage, tenantId: s!.tenantId, userId: s!.userId, wsId: s!.wsId!, mode: s!.mode, now };
    // 状態を変える要求は、端末が認識しているデータ世代と一致すること（復元後の旧端末からの送信を拒否）
    if (!['GET', 'HEAD'].includes(req.method)) {
      const epoch = req.headers['x-data-epoch'];
      if (epoch !== s!.wsId) {
        fail('EPOCH_MISMATCH', 'データが復元または切り替えられました。画面を再読み込みしてから操作してください。', { currentEpoch: s!.wsId });
      }
    }
  };
  const ctxOf = (req: FastifyRequest) => req.ctx!;
  const P = <T extends z.ZodTypeAny>(schema: T, v: unknown): z.infer<T> => schema.parse(v);

  const authLimit = { config: { rateLimit: { max: config.env === 'test' ? 10_000 : Number(process.env.AUTH_RATE_LIMIT_PER_MIN ?? 10), timeWindow: '1 minute' } } };

  app.post('/api/auth/register', authLimit, async (req, reply) => {
    if (config.registration === 'closed') fail('FORBIDDEN', '現在、新規登録を受け付けていません');
    const b = P(z.object({ email: z.string().max(200), password: z.string().max(200), businessName: z.string().max(100) }), req.body);
    await auth.registerAccount(db, b, config.registrationDefaultEntitlement);
    const lg = await auth.login(db, b.email, b.password, config.sessionTtlDays);
    setSessionCookie(reply, lg.token);
    return { ok: true };
  });
  app.post('/api/auth/login', authLimit, async (req, reply) => {
    const b = P(z.object({ email: z.string().max(200), password: z.string().max(200) }), req.body);
    const lg = await auth.login(db, b.email, b.password, config.sessionTtlDays);
    setSessionCookie(reply, lg.token);
    return { ok: true };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    const s = await auth.resolveSession(db, req.cookies[COOKIE]);
    if (s) await auth.logout(db, s.idHash);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  app.post('/api/auth/reset-request', authLimit, async (req) => {
    const b = P(z.object({ email: z.string().max(200) }), req.body);
    const r = await auth.requestPasswordReset(db, b.email);
    if (r && deps.mailer) {
      await deps.mailer(r.userEmail, 'StockPilot パスワード再設定', `次のURLから30分以内に再設定してください。\n${config.publicOrigin}/reset?token=${r.token}`);
    } else if (r && config.mailer === 'console' && config.env !== 'production') {
      console.log(`[dev mailer] reset link for ${r.userEmail}: ${config.publicOrigin}/reset?token=${r.token}`);
    }
    return { ok: true, message: '登録があれば再設定の案内を送信しました' };
  });
  app.post('/api/auth/reset', authLimit, async (req) => {
    const b = P(z.object({ token: z.string().max(200), password: z.string().max(200) }), req.body);
    await auth.resetPassword(db, b.token, b.password);
    return { ok: true };
  });

  // 以降は認証必須
  await app.register(async (r) => {
    r.addHook('preHandler', authed);

    r.get('/api/me', async (req) => {
      const s = req.session!;
      return {
        email: s.email,
        businessName: s.tenantName,
        mode: s.mode,
        dataEpoch: s.wsId,
        entitlement: s.entitlement,
        entitlementUntil: s.entitlementUntil,
        canWriteLive: s.entitlement === 'active',
        serverTime: now().toISOString(),
      };
    });
    r.post('/api/auth/logout-all', async (req, reply) => {
      const n = await auth.revokeAllSessions(db, req.session!.userId);
      reply.clearCookie(COOKIE, { path: '/' });
      return { revoked: n };
    });
    r.post('/api/auth/password', authLimit, async (req, reply) => {
      const b = P(z.object({ current: z.string().max(200), next: z.string().max(200) }), req.body);
      await auth.changePassword(db, req.session!.userId, b.current, b.next);
      reply.clearCookie(COOKIE, { path: '/' });
      return { ok: true };
    });
    r.post('/api/account/delete', authLimit, async (req, reply) => {
      const b = P(z.object({ password: z.string().max(200), confirm: z.string().max(20) }), req.body);
      const res = await auth.deleteAccount(db, req.session!.userId, b.password, b.confirm);
      for (const h of res.fileHashes) {
        const still = await db.query(`SELECT 1 FROM files WHERE sha256=$1 LIMIT 1`, [h]);
        if (still.rowCount === 0) await storage.remove(h);
      }
      reply.clearCookie(COOKIE, { path: '/' });
      return { ok: true };
    });
  });

  // モード切替（dataEpoch 検査の対象外：切替そのものが世代を変える操作）
  app.post('/api/mode', async (req) => {
    const s = await auth.resolveSession(db, req.cookies[COOKIE]);
    if (!s) fail('UNAUTHENTICATED', 'ログインが必要です');
    const b = P(z.object({ mode: z.enum(['live', 'sample']), reset: z.boolean().optional() }), req.body);
    if (b.mode === 'sample' && (!s!.sampleWsId || b.reset)) await createSampleWorkspace(db, storage, s!.tenantId, s!.userId, now);
    await auth.setSessionMode(db, s!.idHash, b.mode);
    const s2 = await auth.resolveSession(db, req.cookies[COOKIE]);
    return { mode: b.mode, dataEpoch: s2!.wsId };
  });

  await app.register(async (r) => {
    r.addHook('preHandler', authed);

    // ---------- 参照 ----------
    r.get('/api/dashboard', async (req) => q.dashboard(ctxOf(req)));
    r.get('/api/idle', async (req) => q.idleSkus(ctxOf(req), P(z.object({ days: z.coerce.number().int().min(7).max(3650).default(90) }), req.query).days));
    r.get('/api/verify', async (req) => q.verifyLedger(ctxOf(req)));
    r.get('/api/resolve', async (req) => q.resolveCode(ctxOf(req), P(z.object({ code: z.string().min(1).max(200) }), req.query).code));
    r.get('/api/inventory', async (req) => {
      const f = P(
        pageQ.extend({
          q: z.string().max(100).optional(),
          locationId: z.string().uuid().optional(),
          supplierId: z.string().uuid().optional(),
          category: z.string().max(100).optional(),
          filter: z.enum(['zero', 'below_safety', 'replenish', 'on_order', 'overdue', 'hold', 'stocktake', 'archived']).optional(),
        }),
        req.query,
      );
      return q.listInventory(ctxOf(req), f);
    });
    r.get('/api/history', async (req) => {
      const f = P(
        z.object({
          skuId: z.string().uuid().optional(),
          locationId: z.string().uuid().optional(),
          opId: z.string().uuid().optional(),
          kind: z.string().max(40).optional(),
          from: S.zDate.optional(),
          to: S.zDate.optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          beforeSeq: z.coerce.number().int().optional(),
        }),
        req.query,
      );
      return q.listHistory(ctxOf(req), f);
    });
    r.get('/api/ops/by-key/:key', async (req) => lookupCommand(ctxOf(req), P(z.object({ key: S.zIdemKey }), req.params).key));
    r.get('/api/ops/:id', async (req) => q.getOperation(ctxOf(req), P(idParam, req.params).id));

    // ---------- マスター ----------
    r.get('/api/skus/:id', async (req) => q.getSku(ctxOf(req), P(idParam, req.params).id));
    r.post('/api/skus', async (req) => masters.createSku(ctxOf(req), P(S.zSkuInput, req.body)));
    r.put('/api/skus/:id', async (req) => {
      const b = P(S.zSkuInput.extend({ version: z.number().int() }), req.body);
      return masters.updateSku(ctxOf(req), P(idParam, req.params).id, b.version, b);
    });
    r.post('/api/skus/:id/archive', async (req) => masters.setSkuArchived(ctxOf(req), P(idParam, req.params).id, P(z.object({ archived: z.boolean() }), req.body).archived));
    r.delete('/api/skus/:id', async (req) => masters.deleteSku(ctxOf(req), P(idParam, req.params).id));
    r.post('/api/skus/:id/codes', async (req) => {
      const b = P(S.zBarcodeInput, req.body);
      return masters.addSkuCode(ctxOf(req), P(idParam, req.params).id, b.code, b.kind);
    });
    r.delete('/api/skus/:id/codes/:codeId', async (req) => {
      const p = P(z.object({ id: z.string().uuid(), codeId: z.string().uuid() }), req.params);
      return masters.removeSkuCode(ctxOf(req), p.id, p.codeId);
    });
    r.put('/api/skus/:id/photo', async (req) => {
      const file = await req.file({ limits: { fileSize: PHOTO_MAX_BYTES + 1 } });
      if (!file) fail('VALIDATION', '写真を選んでください');
      const buf = await file!.toBuffer();
      if (file!.file.truncated || buf.length > PHOTO_MAX_BYTES) fail('TOO_LARGE', `写真は${PHOTO_MAX_BYTES / 1024 / 1024}MBまでです`);
      return masters.setSkuPhoto(ctxOf(req), P(idParam, req.params).id, buf);
    });
    r.delete('/api/skus/:id/photo', async (req) => masters.setSkuPhoto(ctxOf(req), P(idParam, req.params).id, null));
    r.get('/api/files/:id', async (req, reply) => {
      const f = await masters.getFile(ctxOf(req), P(idParam, req.params).id);
      // 画像として配信（HTML/SVG は保存時に拒否済み）。ブラウザのキャッシュは本人の端末内のみ
      reply.header('Content-Type', f.mime).header('Cache-Control', 'private, max-age=3600').header('X-Content-Type-Options', 'nosniff').header('Content-Disposition', 'inline');
      return reply.send(f.data);
    });

    r.get('/api/locations', async (req) => q.listLocations(ctxOf(req), P(z.object({ all: z.coerce.boolean().optional() }), req.query).all));
    r.get('/api/locations/:id/stock', async (req) => q.locationStock(ctxOf(req), P(idParam, req.params).id));
    r.post('/api/locations', async (req) => masters.createLocation(ctxOf(req), P(S.zLocationInput, req.body)));
    r.put('/api/locations/:id', async (req) => {
      const b = P(S.zLocationInput.extend({ version: z.number().int() }), req.body);
      return masters.updateLocation(ctxOf(req), P(idParam, req.params).id, b.version, b);
    });
    r.post('/api/locations/:id/archive', async (req) =>
      masters.setLocationArchived(ctxOf(req), P(idParam, req.params).id, P(z.object({ archived: z.boolean() }), req.body).archived),
    );
    r.delete('/api/locations/:id', async (req) => masters.deleteLocation(ctxOf(req), P(idParam, req.params).id));

    r.get('/api/suppliers', async (req) => q.listSuppliers(ctxOf(req), P(z.object({ all: z.coerce.boolean().optional() }), req.query).all));
    r.post('/api/suppliers', async (req) => masters.createSupplier(ctxOf(req), P(S.zSupplierInput, req.body)));
    r.put('/api/suppliers/:id', async (req) => {
      const b = P(S.zSupplierInput.extend({ version: z.number().int() }), req.body);
      return masters.updateSupplier(ctxOf(req), P(idParam, req.params).id, b.version, b);
    });
    r.post('/api/suppliers/:id/archive', async (req) =>
      masters.setSupplierArchived(ctxOf(req), P(idParam, req.params).id, P(z.object({ archived: z.boolean() }), req.body).archived),
    );

    // ---------- 在庫の確定コマンド ----------
    r.post('/api/ops/initial', async (req) => inv.initialStock(ctxOf(req), P(S.zInitialStockCmd, req.body)));
    r.post('/api/ops/outside-receipt', async (req) => inv.outsideReceipt(ctxOf(req), P(S.zOutsideReceiptCmd, req.body)));
    r.post('/api/ops/issue', async (req) => inv.issue(ctxOf(req), P(S.zIssueCmd, req.body)));
    r.post('/api/ops/transfer', async (req) => inv.transfer(ctxOf(req), P(S.zTransferCmd, req.body)));
    r.post('/api/ops/disposal', async (req) => inv.disposal(ctxOf(req), P(S.zDisposalCmd, req.body)));
    r.post('/api/ops/correction', async (req) => inv.correction(ctxOf(req), P(S.zCorrectionCmd, req.body)));
    r.post('/api/ops/customer-return', async (req) => inv.customerReturn(ctxOf(req), P(S.zCustomerReturnCmd, req.body)));
    r.post('/api/ops/supplier-return', async (req) => inv.supplierReturn(ctxOf(req), P(S.zSupplierReturnCmd, req.body)));
    r.post('/api/ops/reversal', async (req) => inv.reversal(ctxOf(req), P(S.zReversalCmd, req.body)));

    // ---------- 発注 ----------
    r.get('/api/pos', async (req) => {
      const f = P(
        pageQ.extend({
          status: z.enum(['draft', 'open', 'closed', 'all']).optional(),
          supplierId: z.string().uuid().optional(),
          skuId: z.string().uuid().optional(),
          q: z.string().max(100).optional(),
          overdue: z.coerce.boolean().optional(),
          partial: z.coerce.boolean().optional(),
        }),
        req.query,
      );
      return po.listPos(ctxOf(req), f);
    });
    r.get('/api/pos/pending-lines', async (req) => {
      const f = P(
        pageQ.extend({
          supplierId: z.string().uuid().optional(),
          skuId: z.string().uuid().optional(),
          q: z.string().max(100).optional(),
          overdue: z.coerce.boolean().optional(),
          partial: z.coerce.boolean().optional(),
        }),
        req.query,
      );
      return po.listPendingLines(ctxOf(req), f);
    });
    r.get('/api/pos/:id', async (req) => po.getPo(ctxOf(req), P(idParam, req.params).id));
    r.post('/api/pos', async (req) => po.createDraft(ctxOf(req), P(S.zPoDraftInput, req.body)));
    r.put('/api/pos/:id', async (req) => {
      const b = P(S.zPoDraftInput.extend({ version: z.number().int() }), req.body);
      return po.updateDraft(ctxOf(req), P(idParam, req.params).id, b.version, b);
    });
    r.delete('/api/pos/:id', async (req) => po.deleteDraft(ctxOf(req), P(idParam, req.params).id));
    r.post('/api/pos/:id/place', async (req) => po.placeOrder(ctxOf(req), P(idParam, req.params).id, P(S.zPoPlaceCmd, req.body)));
    r.post('/api/pos/:id/revise', async (req) => po.revisePlaced(ctxOf(req), P(idParam, req.params).id, P(S.zPoReviseCmd, req.body)));
    r.post('/api/pos/:id/cancel-remaining', async (req) => po.cancelRemaining(ctxOf(req), P(idParam, req.params).id, P(S.zPoCancelRemainingCmd, req.body)));
    r.post('/api/pos/:id/receive', async (req) => po.receive(ctxOf(req), P(idParam, req.params).id, P(S.zReceiptCmd, req.body)));
    r.post('/api/pos/:id/sheet', async (req) => docs.issuePoSheet(ctxOf(req), P(idParam, req.params).id));

    // ---------- 補充 ----------
    r.get('/api/replenish', async (req) => rep.listCandidates(ctxOf(req), P(z.object({ filter: z.enum(['candidates', 'all', 'unconfigured']).default('candidates') }), req.query).filter));
    r.post('/api/replenish/drafts', async (req) => rep.createDraftsFromCandidates(ctxOf(req), P(rep.zCreateDraftsCmd, req.body)));

    // ---------- 棚卸 ----------
    r.get('/api/stocktakes', async (req) => st.listStocktakes(ctxOf(req), P(pageQ.extend({ active: z.coerce.boolean().optional() }), req.query)));
    r.post('/api/stocktakes', async (req) => st.startStocktake(ctxOf(req), P(S.zStocktakeStartCmd, req.body)));
    r.get('/api/stocktakes/:id', async (req) => st.getStocktake(ctxOf(req), P(idParam, req.params).id));
    r.post('/api/stocktakes/:id/count', async (req) => st.recordCount(ctxOf(req), P(idParam, req.params).id, P(S.zStocktakeCountInput, req.body)));
    r.post('/api/stocktakes/:id/reason', async (req) => st.setReason(ctxOf(req), P(idParam, req.params).id, P(S.zStocktakeReasonInput, req.body)));
    r.post('/api/stocktakes/:id/lines', async (req) => st.addLine(ctxOf(req), P(idParam, req.params).id, P(z.object({ skuId: z.string().uuid() }), req.body).skuId));
    r.post('/api/stocktakes/:id/review', async (req) => st.toReview(ctxOf(req), P(idParam, req.params).id, P(z.object({ version: z.number().int() }), req.body).version));
    r.post('/api/stocktakes/:id/confirm', async (req) => st.confirmStocktake(ctxOf(req), P(idParam, req.params).id, P(S.zStocktakeConfirmCmd, req.body)));
    r.post('/api/stocktakes/:id/cancel', async (req) => st.cancelStocktake(ctxOf(req), P(idParam, req.params).id, P(S.zStocktakeCancelCmd, req.body)));

    // ---------- 帳票 ----------
    r.post('/api/labels', async (req) =>
      docs.issueLabels(
        ctxOf(req),
        P(z.object({ skuIds: z.array(z.string().uuid()).max(480).default([]), locationIds: z.array(z.string().uuid()).max(100).default([]), copies: z.number().int().min(1).max(24).default(1) }), req.body),
      ),
    );
    r.get('/api/documents/:id/pdf', async (req, reply) => {
      const d = await docs.renderDocument(ctxOf(req), P(idParam, req.params).id);
      const dl = P(z.object({ download: z.coerce.boolean().optional() }), req.query).download;
      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `${dl ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(d.filename)}`)
        .header('X-Content-Type-Options', 'nosniff');
      return reply.send(d.pdf);
    });

    // ---------- CSV ----------
    r.get('/api/import/templates/:kind', async (req, reply) => {
      const { kind } = P(z.object({ kind: z.enum(['skus', 'locations', 'suppliers', 'initial_stock', 'po_drafts', 'movements']) }), req.params);
      reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`テンプレート_${kind}.csv`)}`);
      return csv.templateCsv(kind);
    });
    r.get('/api/import', async (req) => csv.listImports(ctxOf(req)));
    r.post('/api/import/preview', async (req) => {
      const file = await req.file({ limits: { fileSize: CSV_MAX_BYTES + 1 } });
      if (!file) fail('VALIDATION', 'CSVファイルを選んでください');
      const buf = await file!.toBuffer();
      if (file!.file.truncated || buf.length > CSV_MAX_BYTES) fail('TOO_LARGE', `CSVは${CSV_MAX_BYTES / 1024 / 1024}MBまでです。ファイルを分割してください。`);
      const fields = file!.fields as Record<string, { value?: string }>;
      const kind = P(z.enum(['skus', 'locations', 'suppliers', 'initial_stock', 'po_drafts', 'movements']), fields.kind?.value);
      const encoding = P(z.enum(['utf-8', 'shift_jis']).default('utf-8'), fields.encoding?.value || undefined);
      const mapping = fields.mapping?.value ? P(z.record(z.string(), z.number().int()), JSON.parse(fields.mapping.value)) : undefined;
      return csv.previewImport(ctxOf(req), { kind, data: buf, fileName: file!.filename ?? '', encoding, mapping });
    });
    r.post('/api/import/:id/commit', async (req) =>
      csv.commitImport(
        ctxOf(req),
        P(idParam, req.params).id,
        P(z.object({ idempotencyKey: S.zIdemKey, excludedRows: z.array(z.number().int()).max(10000).default([]), businessDate: S.zDate }), req.body),
      ),
    );
    r.post('/api/import/:id/discard', async (req) => csv.discardImport(ctxOf(req), P(idParam, req.params).id));
    r.get('/api/export/:kind', async (req, reply) => {
      const { kind } = P(z.object({ kind: z.enum(['skus', 'stock', 'history', 'pos', 'replenish', 'transfers', 'stocktake']) }), req.params);
      const qq = P(z.object({ from: S.zDate.optional(), to: S.zDate.optional(), stocktakeId: z.string().uuid().optional() }), req.query);
      const out = await exp.exportCsv(ctxOf(req), kind, qq);
      reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(out.filename)}`);
      return out.csv;
    });

    // ---------- バックアップ・復元 ----------
    r.get('/api/backup/status', async (req) => backup.backupStatus(ctxOf(req)));
    r.get('/api/backup/export', async (req, reply) => {
      const { filePath } = await backup.exportBackup(ctxOf(req));
      const stream = fs.createReadStream(filePath);
      stream.on('close', () => fs.promises.rm(filePath, { force: true }));
      const name = `StockPilot_backup_${now().toISOString().slice(0, 10)}.zip`;
      reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      return reply.send(stream);
    });
    r.post('/api/backup/restore/preview', async (req) => {
      const file = await req.file({ limits: { fileSize: BACKUP_MAX_BYTES + 1 } });
      if (!file) fail('VALIDATION', 'バックアップファイルを選んでください');
      const tmp = path.join(storage.tmpDir(), `restore-${crypto.randomUUID()}.zip`);
      await fs.promises.writeFile(tmp, await file!.toBuffer(), { mode: 0o600 });
      try {
        if (file!.file.truncated) fail('TOO_LARGE', 'バックアップファイルが大きすぎます');
        return await backup.stageRestore(ctxOf(req), tmp);
      } finally {
        await fs.promises.rm(tmp, { force: true });
      }
    });
    r.post('/api/backup/restore/:id/commit', async (req) => backup.commitRestore(ctxOf(req), P(idParam, req.params).id));
    r.post('/api/backup/restore/:id/discard', async (req) => backup.discardStaging(ctxOf(req), P(idParam, req.params).id));
    r.post('/api/backup/rollback', async (req) => backup.rollbackRestore(ctxOf(req)));
  });

  app.get('/api/health', async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  // ---------- Web（ビルド済みSPA）----------
  if (fs.existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: '/',
      index: ['index.html'],
      setHeaders: (res, p) => {
        if (p.endsWith('sw.js') || p.endsWith('index.html') || p.endsWith('manifest.webmanifest')) res.header('Cache-Control', 'no-cache');
        else if (p.includes(`${path.sep}assets${path.sep}`)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '見つかりません' } });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
