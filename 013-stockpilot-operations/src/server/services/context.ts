import crypto from 'node:crypto';
import type { Db, Tx } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { AppError, fail } from '../errors.js';
import { tokyoToday } from '../../shared/dates.js';
import type { Storage } from '../storage.js';

/** 認証済みリクエストから組み立てる業務コンテキスト */
export interface Ctx {
  db: Db;
  storage: Storage;
  tenantId: string;
  userId: string;
  wsId: string; // データ世代（dataEpoch）
  mode: 'live' | 'sample';
  now: () => Date;
}

export const today = (ctx: Ctx) => tokyoToday(ctx.now());

export const uuid = () => crypto.randomUUID();

/** キー順を固定した JSON（要求内容ハッシュ用） */
export function stableStringify(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * トランザクション先頭で、所属とデータ世代を検証する。
 * tenants 行を FOR SHARE でロックし、復元による世代切替（FOR UPDATE）と直列化する。
 */
export async function verifyWorkspace(c: Tx, ctx: Ctx, write: boolean): Promise<void> {
  const r = await c.query(
    `SELECT active_ws_id, sample_ws_id, entitlement, entitlement_until FROM tenants WHERE id = $1 FOR SHARE`,
    [ctx.tenantId],
  );
  if (r.rowCount === 0) fail('UNAUTHENTICATED', 'アカウントが見つかりません');
  const t = r.rows[0];
  const expected = ctx.mode === 'sample' ? t.sample_ws_id : t.active_ws_id;
  if (expected !== ctx.wsId) {
    fail('EPOCH_MISMATCH', 'データが復元または切り替えられました。画面を再読み込みしてから操作してください。', { currentEpoch: expected });
  }
  if (write && ctx.mode === 'live') {
    const until = t.entitlement_until as string | null;
    if (t.entitlement !== 'active' || (until && until < today(ctx))) {
      fail('ENTITLEMENT_REQUIRED', '利用権が有効ではありません。サンプルでの操作のみ可能です。');
    }
  }
}

/** 読み取り用トランザクション（世代検証付き） */
export function readTx<T>(ctx: Ctx, fn: (c: Tx) => Promise<T>): Promise<T> {
  return withTx(ctx.db, async (c) => {
    await verifyWorkspace(c, ctx, false);
    return fn(c);
  });
}

/** 冪等キーを持たない書き込み（マスター編集等。版番号で競合検出する） */
export function writeTx<T>(ctx: Ctx, fn: (c: Tx) => Promise<T>): Promise<T> {
  return withTx(ctx.db, async (c) => {
    await verifyWorkspace(c, ctx, true);
    return fn(c);
  });
}

export interface CommandResult<T> {
  replayed: boolean;
  result: T;
}

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * 確定コマンドの共通実行（API_CONTRACTS.md §冪等性）
 * 1. 世代検証 2. 冪等キー検査（同キー同内容→前回結果、同キー別内容→拒否）3. 本処理 4. 結果保存
 * 同じキーの同時実行は command_log の一意索引で待たされ、先行がコミットすれば前回結果を返す。
 */
export async function runCommand<T>(
  ctx: Ctx,
  command: string,
  idemKey: unknown,
  payload: unknown,
  fn: (c: Tx) => Promise<T>,
): Promise<CommandResult<T>> {
  if (typeof idemKey !== 'string' || !KEY_RE.test(idemKey)) fail('VALIDATION', '操作キー（idempotencyKey）が不正です');
  const hash = sha256(stableStringify({ command, payload }));
  return withTx(ctx.db, async (c) => {
    await verifyWorkspace(c, ctx, true);
    const ins = await c.query(
      `INSERT INTO command_log (ws_id, idem_key, request_hash, command, result) VALUES ($1,$2,$3,$4,'null'::jsonb)
       ON CONFLICT DO NOTHING RETURNING idem_key`,
      [ctx.wsId, idemKey, hash, command],
    );
    if (ins.rowCount === 0) {
      const ex = await c.query(`SELECT request_hash, result FROM command_log WHERE ws_id=$1 AND idem_key=$2`, [ctx.wsId, idemKey]);
      if (ex.rows[0].request_hash !== hash) {
        fail('IDEMPOTENCY_CONFLICT', '同じ操作キーで異なる内容が送信されました。新しい操作としてやり直してください。');
      }
      return { replayed: true, result: ex.rows[0].result as T };
    }
    const result = await fn(c);
    await c.query(`UPDATE command_log SET result=$3 WHERE ws_id=$1 AND idem_key=$2`, [ctx.wsId, idemKey, JSON.stringify(result ?? null)]);
    return { replayed: false, result };
  });
}

/** 冪等キーの処理状況照会（結果不明時の確認用） */
export async function lookupCommand(ctx: Ctx, idemKey: string): Promise<{ found: boolean; command?: string; result?: unknown }> {
  const r = await ctx.db.query(`SELECT command, result FROM command_log WHERE ws_id=$1 AND idem_key=$2`, [ctx.wsId, idemKey]);
  if (r.rowCount === 0) return { found: false };
  return { found: true, command: r.rows[0].command, result: r.rows[0].result };
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
