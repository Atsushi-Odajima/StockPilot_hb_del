import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { PDFParse } from 'pdf-parse';
import { testApp, Client, k } from './api-helpers.js';
import { closeDb, TODAY } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await testApp();
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

async function setupBasic(c: Client) {
  const sup = await c.ok(c.post('/api/suppliers', { code: 'SUP1', name: '仕入先1' }));
  const a = await c.ok(c.post('/api/locations', { code: 'A', name: '棚A', kind: 'normal' }));
  const h = await c.ok(c.post('/api/locations', { code: 'H', name: '保留', kind: 'hold' }));
  const s = await c.ok(c.post('/api/skus', { code: '00123', name: 'テスト商品', supplierId: sup.id, memo: 'INTERNAL-MEMO-SECRET-XYZ' }));
  await c.ok(c.post(`/api/skus/${s.id}/codes`, { code: '4901234567894', kind: 'JAN13' }));
  await c.ok(c.post('/api/ops/initial', { idempotencyKey: k(), businessDate: TODAY, lines: [{ skuId: s.id, locationId: a.id, qty: 10 }] }));
  return { sup: sup.id, a: a.id, h: h.id, s: s.id };
}

describe('認証・CSRF', () => {
  it('未ログインは401、CSRFヘッダーなし・別Originは403', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/me' });
    expect(r.statusCode).toBe(401);
    const c = new Client(app);
    await c.register();
    const noCsrf = await app.inject({ method: 'POST', url: '/api/locations', headers: { cookie: c.cookie, 'x-data-epoch': c.epoch }, payload: { code: 'X', name: 'X', kind: 'normal' } });
    expect(noCsrf.statusCode).toBe(403);
    const badOrigin = await c.post('/api/locations', { code: 'X', name: 'X', kind: 'normal' }, { origin: 'https://evil.example' });
    expect(badOrigin.statusCode).toBe(403);
    const ok = await c.post('/api/locations', { code: 'X', name: 'X', kind: 'normal' });
    expect(ok.statusCode).toBe(200);
  });
  it('間違ったパスワードは拒否、ログアウト後のセッションは無効', async () => {
    const c = new Client(app);
    const email = await c.register();
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-stockpilot-csrf': '1' }, payload: { email, password: 'wrong-password-123' } });
    expect(bad.statusCode).toBe(401);
    await c.ok(c.post('/api/auth/logout', {}));
    expect((await c.get('/api/me')).statusCode).toBe(401);
  });
  it('全セッション失効', async () => {
    const c1 = new Client(app);
    const email = await c1.register();
    const c2 = new Client(app);
    const lg = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-stockpilot-csrf': '1' }, payload: { email, password: 'correct-horse-battery' } });
    c2.cookie = String(lg.headers['set-cookie']).split(';')[0];
    await c2.refreshEpoch();
    await c1.ok(c1.post('/api/auth/logout-all', {}));
    expect((await c2.get('/api/me')).statusCode).toBe(401);
  });
  it('パスワード再設定：トークンは1回限り、旧セッションは失効', async () => {
    const c = new Client(app);
    const email = await c.register();
    const { requestPasswordReset } = await import('../src/server/services/auth.js');
    const { db } = await import('./helpers.js');
    const r = await requestPasswordReset(db(), email);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/reset', headers: { 'x-stockpilot-csrf': '1' }, payload: { token: r!.token, password: 'new-password-long-1' } });
    expect(ok.statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/api/auth/reset', headers: { 'x-stockpilot-csrf': '1' }, payload: { token: r!.token, password: 'new-password-long-2' } });
    expect(again.statusCode).toBe(400);
    expect((await c.get('/api/me')).statusCode).toBe(401);
  });
});

describe('T26 別事業者', () => {
  it('他者の商品・場所・発注・棚卸・画像・QR・伝票で閲覧も操作も拒否', async () => {
    const a = new Client(app);
    await a.register();
    const b = new Client(app);
    await b.register();
    const A = await setupBasic(a);
    const photo = await a.ok(a.upload(`/api/skus/${A.s}/photo`, PNG_1PX, 'p.png', {}, 'image/png'));
    const dr = await a.ok(a.post('/api/pos', { supplierId: A.sup, lines: [{ skuId: A.s, qty: 5, locationId: A.a }] }));
    const stt = await a.ok(a.post('/api/stocktakes', { idempotencyKey: k(), locationId: A.h, businessDate: TODAY }));
    const hist = await a.ok(a.get(`/api/history?skuId=${A.s}`));
    const opId = hist.rows[0].opId;
    const sheet = await a.ok(a.post(`/api/pos/${dr.id}/sheet`, {}));
    // B からの参照はすべて404（存在も明かさない）
    for (const url of [`/api/skus/${A.s}`, `/api/pos/${dr.id}`, `/api/stocktakes/${stt.result.id}`, `/api/files/${photo.fileId}`, `/api/ops/${opId}`, `/api/documents/${sheet.documentId}/pdf`]) {
      expect((await b.get(url)).statusCode, url).toBe(404);
    }
    expect((await b.get(`/api/locations/${A.a}/stock`)).json()).toEqual([]);
    // 内部QRは事業者内でしか解決しない
    const qr = await b.ok(b.get(`/api/resolve?code=${encodeURIComponent(`SP:1:SKU:${A.s}`)}`));
    expect(qr.type).toBe('unknown');
    const own = await a.ok(a.get(`/api/resolve?code=${encodeURIComponent(`SP:1:SKU:${A.s}`)}`));
    expect(own).toMatchObject({ type: 'sku', skuId: A.s });
    // 操作も拒否（他者のIDを差し込んでも到達しない）
    const bLoc = await b.ok(b.post('/api/locations', { code: 'BA', name: 'B棚', kind: 'normal' }));
    expect((await b.post('/api/ops/issue', { idempotencyKey: k(), businessDate: TODAY, purpose: 'sale', lines: [{ skuId: A.s, locationId: A.a, qty: 1 }] })).statusCode).toBe(404);
    expect((await b.post('/api/ops/outside-receipt', { idempotencyKey: k(), businessDate: TODAY, reason: 'x', lines: [{ skuId: A.s, locationId: bLoc.id, qty: 1 }] })).statusCode).toBe(404);
    expect((await b.post(`/api/pos/${dr.id}/place`, { idempotencyKey: k(), version: 1, orderedDate: TODAY })).statusCode).toBe(404);
    expect((await b.post(`/api/stocktakes/${stt.result.id}/cancel`, { idempotencyKey: k(), reason: 'x' })).statusCode).toBe(404);
    expect((await b.put(`/api/skus/${A.s}`, { code: 'HACK', name: 'x', version: 1 })).statusCode).toBe(404);
    expect((await b.post(`/api/skus/${A.s}/archive`, { archived: true })).statusCode).toBe(404);
    expect((await b.post('/api/labels', { skuIds: [A.s] })).statusCode).toBe(404);
    expect((await b.post('/api/pos', { supplierId: A.sup, lines: [] })).statusCode).toBe(404);
    // A の在庫は変わっていない
    const inv = await a.ok(a.get(`/api/skus/${A.s}`));
    expect(inv.available).toBe(10);
  });
});

describe('入出庫API・冪等・結果照会', () => {
  it('同じキーの再送は前回結果、キー照会で処理状況を確認できる', async () => {
    const c = new Client(app);
    await c.register();
    const A = await setupBasic(c);
    const key = k();
    const body = { idempotencyKey: key, businessDate: TODAY, purpose: 'sale', lines: [{ skuId: A.s, locationId: A.a, qty: 3 }] };
    const r1 = await c.ok(c.post('/api/ops/issue', body));
    const r2 = await c.ok(c.post('/api/ops/issue', body));
    expect(r2.replayed).toBe(true);
    expect(r2.result.opNo).toBe(r1.result.opNo);
    const look = await c.ok(c.get(`/api/ops/by-key/${key}`));
    expect(look.found).toBe(true);
    const none = await c.ok(c.get(`/api/ops/by-key/${k()}`));
    expect(none.found).toBe(false);
    expect((await c.ok(c.get(`/api/skus/${A.s}`))).available).toBe(7);
  });
  it('写真は実体検査：HTMLをJPEGと偽っても拒否', async () => {
    const c = new Client(app);
    await c.register();
    const A = await setupBasic(c);
    const r = await c.upload(`/api/skus/${A.s}/photo`, Buffer.from('<html><script>alert(1)</script></html>'), 'x.jpg', {}, 'image/jpeg');
    expect(r.statusCode).toBe(400);
    const svg = await c.upload(`/api/skus/${A.s}/photo`, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.svg', {}, 'image/svg+xml');
    expect(svg.statusCode).toBe(400);
    const ok = await c.upload(`/api/skus/${A.s}/photo`, PNG_1PX, 'x.png', {}, 'image/png');
    expect(ok.statusCode).toBe(200);
    const f = await c.get(`/api/files/${ok.json().fileId}`);
    expect(f.headers['content-type']).toBe('image/png');
    expect(f.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('T24/T25 CSV', () => {
  it('同じバッチは1回だけ確定。同日・同SKU・同数の別実取引を自動削除しない', async () => {
    const c = new Client(app);
    await c.register();
    const A = await setupBasic(c);
    const csvText = '種別,日付,SKUコード,場所コード,数量,目的,理由\n出庫,2026-03-30,00123,A,1,販売,\n出庫,2026-03-30,00123,A,1,販売,\n';
    const buf = Buffer.from('﻿' + csvText);
    const pv = await c.ok(c.upload('/api/import/preview', buf, 'mv.csv', { kind: 'movements', encoding: 'utf-8' }));
    expect(pv.errorCount).toBe(0);
    expect(pv.rowCount).toBe(2);
    // プレビューでは在庫不変
    expect((await c.ok(c.get(`/api/skus/${A.s}`))).available).toBe(10);
    const cm = await c.ok(c.post(`/api/import/${pv.importId}/commit`, { idempotencyKey: k(), businessDate: TODAY }));
    expect(cm.result.imported).toBe(2); // 同じ内容の2行は別取引として両方取り込む
    expect((await c.ok(c.get(`/api/skus/${A.s}`))).available).toBe(8);
    // 同じファイルの再取込（列割当を変えても）は二重取込しない
    const pv2 = await c.ok(c.upload('/api/import/preview', buf, 'mv-renamed.csv', { kind: 'movements', encoding: 'utf-8', mapping: JSON.stringify({ ...pv.mapping, reason: 5 }) }));
    expect(pv2.alreadyCommittedImportId).toBe(pv.importId);
    const dup = await c.post(`/api/import/${pv2.importId}/commit`, { idempotencyKey: k(), businessDate: TODAY });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('IMPORT_DUPLICATE');
    expect((await c.ok(c.get(`/api/skus/${A.s}`))).available).toBe(8);
  });
  it('エラー行は修正か明示除外まで確定できない。バッチは原子的', async () => {
    const c = new Client(app);
    await c.register();
    const A = await setupBasic(c);
    const csvText = '種別,日付,SKUコード,場所コード,数量,目的,理由\n出庫,2026-03-30,00123,A,1,販売,\n出庫,2026-02-30,00123,A,1,販売,\n出庫,2026-03-30,0123,A,1,販売,\n出庫,2026-03-30,00123,A,1.5,販売,\n';
    const pv = await c.ok(c.upload('/api/import/preview', Buffer.from(csvText), 'bad.csv', { kind: 'movements', encoding: 'utf-8' }));
    expect(pv.errorCount).toBe(3);
    const msgs = pv.rows.flatMap((r: any) => r.errors).join('\n');
    expect(msgs).toContain('2026-02-30');
    expect(msgs).toContain('「0123」が登録されていません');
    expect(msgs).toContain('1.5');
    const fail = await c.post(`/api/import/${pv.importId}/commit`, { idempotencyKey: k(), businessDate: TODAY });
    expect(fail.statusCode).toBe(400);
    expect((await c.ok(c.get(`/api/skus/${A.s}`))).available).toBe(10);
    // 在庫不足行を含むと全体が戻る
    const csv2 = '種別,日付,SKUコード,場所コード,数量,目的,理由\n出庫,2026-03-30,00123,A,4,販売,\n出庫,2026-03-30,00123,A,7,販売,\n';
    const pv3 = await c.ok(c.upload('/api/import/preview', Buffer.from(csv2), 'short.csv', { kind: 'movements', encoding: 'utf-8' }));
    const r3 = await c.post(`/api/import/${pv3.importId}/commit`, { idempotencyKey: k(), businessDate: TODAY });
    expect(r3.statusCode).toBe(422);
    expect((await c.ok(c.get(`/api/skus/${A.s}`))).available).toBe(10);
    // 明示除外なら確定できる
    const ok = await c.ok(c.post(`/api/import/${pv.importId}/commit`, { idempotencyKey: k(), businessDate: TODAY, excludedRows: [3, 4, 5] }));
    expect(ok.result.imported).toBe(1);
    expect((await c.ok(c.get(`/api/skus/${A.s}`))).available).toBe(9);
  });
  it('T25 先頭ゼロ・引用符・改行・Shift_JIS・数式防止', async () => {
    const c = new Client(app);
    await c.register();
    await c.ok(c.post('/api/suppliers', { code: 'SUP1', name: '仕入先1' }));
    const csvText = 'SKUコード,商品名,内部メモ,JAN\n"00042","商品, ""特別""",=HYPERLINK("x"),0012345678905\n00043,"改行\nあり",,\n';
    const pv = await c.ok(c.upload('/api/import/preview', Buffer.from('﻿' + csvText), 's.csv', { kind: 'skus', encoding: 'utf-8' }));
    expect(pv.errorCount).toBe(0);
    await c.ok(c.post(`/api/import/${pv.importId}/commit`, { idempotencyKey: k(), businessDate: TODAY }));
    const list = await c.ok(c.get('/api/inventory?q=0004'));
    expect(list.rows.map((r: any) => r.code).sort()).toEqual(['00042', '00043']);
    expect(list.rows.find((r: any) => r.code === '00042').name).toBe('商品, "特別"');
    // JAN の先頭ゼロ（スキャン解決）
    const res = await c.ok(c.get('/api/resolve?code=0012345678905'));
    expect(res.type).toBe('sku');
    const bySku = await c.ok(c.get('/api/resolve?code=00042'));
    expect(bySku.skuId).toBe(res.skuId);
    // 出力：先頭ゼロ維持・数式無効化・BOM
    const out = await c.get('/api/export/skus');
    const text = out.body;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('"00042"');
    expect(text).toContain('"0012345678905:JAN13"');
    expect(text).toContain('"商品, ""特別"""');
    // Shift_JIS 明示選択
    const { default: toShiftJis } = await import('./sjis.js');
    const sj = toShiftJis('場所コード,場所名,種類\nLOC-01,棚あ,通常\n');
    const bad = await c.upload('/api/import/preview', sj, 'l.csv', { kind: 'locations', encoding: 'utf-8' });
    expect(bad.statusCode).toBe(400);
    const good = await c.ok(c.upload('/api/import/preview', sj, 'l.csv', { kind: 'locations', encoding: 'shift_jis' }));
    expect(good.errorCount).toBe(0);
    expect(good.rows[0].values.name).toBe('棚あ');
  });
  it('数式として解釈される文字列は出力で無効化', async () => {
    const { csvCell } = await import('../src/server/services/csv.js');
    expect(csvCell('=SUM(A1)')).toBe(`"'=SUM(A1)"`);
    expect(csvCell('+81-90')).toBe(`"'+81-90"`);
    expect(csvCell('@x')).toBe(`"'@x"`);
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('00123')).toBe('"00123"');
    expect(csvCell(Number.NaN)).toBe('');
  });
  it('行数上限を超えると途中で切らずに停止', async () => {
    const c = new Client(app);
    await c.register();
    const rows = ['SKUコード,場所コード,数量', ...Array.from({ length: 2001 }, (_, i) => `S${i},A,1`)].join('\n');
    const r = await c.upload('/api/import/preview', Buffer.from(rows), 'big.csv', { kind: 'initial_stock', encoding: 'utf-8' });
    expect(r.statusCode).toBe(413);
    expect(r.json().error.message).toContain('分割');
  });
});

async function unzip(buf: Buffer): Promise<Map<string, Buffer>> {
  const zf: yauzl.ZipFile = await new Promise((res, rej) => yauzl.fromBuffer(buf, { lazyEntries: true }, (e, z) => (e ? rej(e) : res(z!))));
  const out = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zf.on('entry', (en) => {
      zf.openReadStream(en, (err, rs) => {
        if (err) return reject(err);
        const ch: Buffer[] = [];
        rs!.on('data', (c) => ch.push(c));
        rs!.on('end', () => {
          out.set(en.fileName, Buffer.concat(ch));
          zf.readEntry();
        });
      });
    });
    zf.on('end', resolve);
    zf.readEntry();
  });
  return out;
}
async function zip(entries: Map<string, Buffer>): Promise<Buffer> {
  const z = new yazl.ZipFile();
  for (const [n, b] of entries) z.addBuffer(b, n);
  z.end();
  const ch: Buffer[] = [];
  for await (const c of z.outputStream) ch.push(c as Buffer);
  return Buffer.concat(ch);
}

describe('T27–T29 バックアップ・復元', () => {
  it('T27 出力 → 空のデータ世代へ復元 → 数量・発注残・台帳・画像・履歴が一致。T29 旧端末は拒否', async () => {
    const src = new Client(app);
    await src.register();
    const A = await setupBasic(src);
    await src.ok(src.upload(`/api/skus/${A.s}/photo`, PNG_1PX, 'p.png', {}, 'image/png'));
    const dr = await src.ok(src.post('/api/pos', { supplierId: A.sup, lines: [{ skuId: A.s, qty: 100, locationId: A.a }] }));
    await src.ok(src.post(`/api/pos/${dr.id}/place`, { idempotencyKey: k(), version: dr.version, orderedDate: TODAY }));
    const p = await src.ok(src.get(`/api/pos/${dr.id}`));
    await src.ok(src.post(`/api/pos/${dr.id}/receive`, { idempotencyKey: k(), businessDate: TODAY, lines: [{ poLineId: p.lines[0].id, splits: [{ locationId: A.a, qty: 60 }, { locationId: A.h, qty: 5 }] }] }));
    await src.ok(src.post('/api/ops/issue', { idempotencyKey: k(), businessDate: TODAY, purpose: 'sale', lines: [{ skuId: A.s, locationId: A.a, qty: 7 }] }));
    const backupRes = await src.get('/api/backup/export');
    expect(backupRes.statusCode).toBe(200);
    const zipBuf = backupRes.rawPayload;
    const before = await src.ok(src.get(`/api/skus/${A.s}`));
    const histBefore = await src.ok(src.get('/api/history?limit=200'));

    // 別アカウント（空）へ復元
    const dst = new Client(app);
    await dst.register();
    const oldEpoch = dst.epoch;
    const pv = await dst.ok(dst.upload('/api/backup/restore/preview', zipBuf, 'b.zip'));
    expect(pv.manifest.counts.skus).toBe(1);
    // 準備段階では現在データは不変
    expect((await dst.ok(dst.get('/api/inventory'))).rows).toHaveLength(0);
    const cm = await dst.ok(dst.post(`/api/backup/restore/${pv.stagingId}/commit`, {}));
    expect(cm.dataEpoch).not.toBe(oldEpoch);
    // T29：旧世代の dataEpoch で確定要求 → 拒否
    const stale = await dst.post('/api/locations', { code: 'Z', name: 'Z', kind: 'normal' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('EPOCH_MISMATCH');
    await dst.refreshEpoch();
    const after = await dst.ok(dst.get(`/api/skus/${A.s}`));
    expect(after.balances).toEqual(before.balances);
    expect(after.available).toBe(before.available);
    expect(after.hold).toBe(5);
    expect(after.onOrder).toBe(35);
    const img = await dst.get(`/api/files/${after.photoFileId}`);
    expect(img.statusCode).toBe(200);
    expect(Buffer.compare(img.rawPayload, PNG_1PX)).toBe(0);
    const histAfter = await dst.ok(dst.get('/api/history?limit=200'));
    expect(histAfter.rows.map((r: any) => [r.opNo, r.kind, r.qty])).toEqual(histBefore.rows.map((r: any) => [r.opNo, r.kind, r.qty]));
    expect((await dst.ok(dst.get('/api/verify'))).ok).toBe(true);
    // 復元後も続けて操作でき、採番が続く
    const op = await dst.ok(dst.post('/api/ops/issue', { idempotencyKey: k(), businessDate: TODAY, purpose: 'sale', lines: [{ skuId: A.s, locationId: A.a, qty: 1 }] }));
    expect(op.result.opNo > histBefore.rows[0].opNo).toBe(true);
    // 元に戻す（退避世代へ）
    const rb = await dst.ok(dst.post('/api/backup/rollback', {}));
    expect(rb.dataEpoch).toBe(oldEpoch);
    await dst.refreshEpoch();
    expect((await dst.ok(dst.get('/api/inventory'))).rows).toHaveLength(0);
  });

  it('T28 欠落画像・ハッシュ不一致・参照切れ・未来バージョン・パストラバーサルを拒否。現データ不変', async () => {
    const src = new Client(app);
    await src.register();
    const A = await setupBasic(src);
    await src.ok(src.upload(`/api/skus/${A.s}/photo`, PNG_1PX, 'p.png', {}, 'image/png'));
    const good = await unzip((await src.get('/api/backup/export')).rawPayload);
    const dst = new Client(app);
    await dst.register();
    const loc = await dst.ok(dst.post('/api/locations', { code: 'KEEP', name: '既存', kind: 'normal' }));
    const tryRestore = async (m: Map<string, Buffer>) => dst.upload('/api/backup/restore/preview', await zip(m), 'b.zip');
    const manifest = JSON.parse(good.get('manifest.json')!.toString());
    const crypto = await import('node:crypto');
    const h = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

    // 欠落画像
    const m1 = new Map(good);
    for (const key of [...m1.keys()]) if (key.startsWith('files/')) m1.delete(key);
    expect((await tryRestore(m1)).json().error.code).toBe('RESTORE_INVALID');
    // ハッシュ不一致
    const m2 = new Map(good);
    const skus = JSON.parse(m2.get('data/skus.json')!.toString());
    skus[0].name = '改ざん';
    m2.set('data/skus.json', Buffer.from(JSON.stringify(skus)));
    expect((await tryRestore(m2)).json().error.message).toContain('ハッシュ');
    // 参照切れ（マニフェストも整合させた上で、残高のSKUを消す）
    const m3 = new Map(good);
    const man3 = JSON.parse(JSON.stringify(manifest));
    const codes: any[] = [];
    const b3 = Buffer.from(JSON.stringify(codes));
    m3.set('data/sku_codes.json', b3);
    const bal = JSON.parse(m3.get('data/balances.json')!.toString());
    bal[0].sku_id = crypto.randomUUID();
    const bb = Buffer.from(JSON.stringify(bal));
    m3.set('data/balances.json', bb);
    for (const d of man3.data) {
      if (d.path === 'data/sku_codes.json') Object.assign(d, { size: b3.length, sha256: h(b3) });
      if (d.path === 'data/balances.json') Object.assign(d, { size: bb.length, sha256: h(bb) });
    }
    man3.counts.sku_codes = 0;
    m3.set('manifest.json', Buffer.from(JSON.stringify(man3)));
    expect((await tryRestore(m3)).json().error.code).toBe('RESTORE_INVALID');
    // 未来バージョン
    const m4 = new Map(good);
    m4.set('manifest.json', Buffer.from(JSON.stringify({ ...manifest, schemaVersion: 9999 })));
    expect((await tryRestore(m4)).json().error.message).toContain('新しい版');
    // パストラバーサル
    const m5 = new Map(good);
    m5.set('aa/evil.txt', Buffer.from('x'));
    const z5 = await zip(m5);
    // yazl は ../ を書けないため、同じ長さの名前をバイト列で置き換えて細工する
    let idx = z5.indexOf('aa/evil.txt');
    while (idx >= 0) {
      z5.write('../evil.txt', idx, 'latin1');
      idx = z5.indexOf('aa/evil.txt');
    }
    const r5 = await dst.upload('/api/backup/restore/preview', z5, 'b.zip');
    expect(r5.json().error.code).toBe('RESTORE_INVALID');
    // 現データ不変
    const locs = await dst.ok(dst.get('/api/locations'));
    expect(locs.map((l: any) => l.id)).toEqual([loc.id]);
  });
});

describe('T30 帳票', () => {
  it('内部メモの検査文字列が発注書・QRラベルの抽出テキストに含まれない', async () => {
    const c = new Client(app);
    await c.register();
    const A = await setupBasic(c);
    const MEMO = 'INTERNAL-MEMO-SECRET-XYZ';
    const dr = await c.ok(
      c.post('/api/pos', { supplierId: A.sup, dueDate: '2026-04-15', internalMemo: MEMO, supplierNote: '納品時に連絡ください', lines: [{ skuId: A.s, qty: 12, locationId: A.a }] }),
    );
    const sheet = await c.ok(c.post(`/api/pos/${dr.id}/sheet`, {}));
    const pdf = await c.get(`/api/documents/${sheet.documentId}/pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const text = (await new PDFParse({ data: pdf.rawPayload }).getText()).text;
    expect(text).toContain('数量発注書');
    expect(text).toContain('テスト商品');
    expect(text).toContain('12');
    expect(text).toContain('納品時に連絡ください');
    expect(text).not.toContain(MEMO);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // 内部IDを出さない
    expect(pdf.rawPayload.toString('latin1')).not.toContain(MEMO);
    // 発注書の生成で発注済みにならない
    expect((await c.ok(c.get(`/api/pos/${dr.id}`))).status).toBe('draft');
    const lbl = await c.ok(c.post('/api/labels', { skuIds: [A.s], locationIds: [A.a], copies: 2 }));
    expect(lbl.count).toBe(4);
    const lpdf = await c.get(`/api/documents/${lbl.documentId}/pdf`);
    const ltext = (await new PDFParse({ data: lpdf.rawPayload }).getText()).text;
    expect(ltext).toContain('00123');
    expect(ltext).toContain('棚A');
    expect(ltext).not.toContain(MEMO);
    // マスター変更後も既存の帳票は発行時の内容
    const sku = await c.ok(c.get(`/api/skus/${A.s}`));
    await c.ok(c.put(`/api/skus/${A.s}`, { code: '00123', name: '名称変更後', version: sku.version, supplierId: A.sup }));
    const again = (await new PDFParse({ data: (await c.get(`/api/documents/${sheet.documentId}/pdf`)).rawPayload }).getText()).text;
    expect(again).toContain('テスト商品');
    expect(again).not.toContain('名称変更後');
  });
});

describe('サンプル領域', () => {
  it('サンプルは本番と分離され、必要なケースを含む', async () => {
    const c = new Client(app);
    await c.register();
    const A = await setupBasic(c);
    const live = c.epoch;
    const m = await c.ok(c.post('/api/mode', { mode: 'sample' }));
    expect(m.dataEpoch).not.toBe(live);
    c.epoch = m.dataEpoch;
    const inv = await c.ok(c.get('/api/inventory?limit=200'));
    expect(inv.rows.length).toBeGreaterThanOrEqual(20);
    const dash = await c.ok(c.get('/api/dashboard'));
    expect(dash.zero_skus).toBeGreaterThan(0);
    expect(dash.below_safety).toBeGreaterThan(0);
    expect(dash.replenish_candidates).toBeGreaterThan(0);
    expect(dash.overdue_lines).toBeGreaterThan(0);
    expect(dash.hold_skus).toBeGreaterThan(0);
    expect((await c.ok(c.get('/api/verify'))).ok).toBe(true);
    const locs = await c.ok(c.get('/api/locations'));
    expect(locs.filter((l: any) => l.kind === 'normal')).toHaveLength(3);
    expect(locs.filter((l: any) => l.kind === 'hold')).toHaveLength(1);
    const kinds = new Set((await c.ok(c.get('/api/history?limit=200'))).rows.map((r: any) => r.kind));
    for (const kk of ['po_receipt', 'transfer_out', 'customer_return', 'reversal', 'stocktake_adjust', 'issue_sale']) expect(kinds.has(kk), kk).toBe(true);
    const pos = await c.ok(c.get('/api/pos?status=all'));
    expect(pos.some((p: any) => p.displayStatus === 'partial')).toBe(true);
    expect(pos.some((p: any) => p.overdue)).toBe(true);
    expect(pos.some((p: any) => p.status === 'draft')).toBe(true);
    const repl = await c.ok(c.get('/api/replenish'));
    const wh = repl.find((r: any) => r.skuCode === 'TS-WH-M');
    expect(wh).toMatchObject({ available: 5, onOrder: 20, recommended: 0, belowSafety: true });
    expect(repl.find((r: any) => r.skuCode === 'TS-BK-M').recommended).toBe(25);
    // 本番に戻ると本番データのまま
    const back = await c.ok(c.post('/api/mode', { mode: 'live' }));
    c.epoch = back.dataEpoch;
    expect(back.dataEpoch).toBe(live);
    expect((await c.ok(c.get(`/api/skus/${A.s}`))).available).toBe(10);
    expect((await c.ok(c.get('/api/inventory'))).rows).toHaveLength(1);
  });
});
