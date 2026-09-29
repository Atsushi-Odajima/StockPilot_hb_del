// 負荷測定（TEST_REPORT.md に結果を記録）。架空データのみ使用。
// 目標規模：SKU 5,000 / 場所 50 / 台帳 50,000行 / 発注 5,000件 / 棚卸 1場所 5,000SKU
// 実行: LOAD_DATABASE_URL=postgres://.../stockpilot_load npx tsx scripts/loadtest.ts
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { createPool, withTx } from '../src/server/db/pool.js';
import { migrate } from '../src/server/db/migrate.js';
import { LocalStorage } from '../src/server/storage.js';
import { registerAccount } from '../src/server/services/auth.js';
import { insertLocation, insertSku, insertSupplier } from '../src/server/services/masters.js';
import * as inv from '../src/server/services/inventory.js';
import * as po from '../src/server/services/po.js';
import * as st from '../src/server/services/stocktake.js';
import * as q from '../src/server/services/queries.js';
import { loadReplenishRows } from '../src/server/services/replenish.js';
import { exportCsv } from '../src/server/services/exports.js';
import { exportBackup, stageRestore, discardStaging } from '../src/server/services/backup.js';
import type { Ctx } from '../src/server/services/context.js';

const URL = process.env.LOAD_DATABASE_URL ?? 'postgres://stockpilot:stockpilot@localhost:5432/stockpilot_load';
const N_SKU = 5000;
const N_LOC = 50;
const N_PO = 5000;
const TODAY = '2026-09-29';
const k = () => crypto.randomUUID();
const results: { step: string; ms: number; rssMB: number; note?: string }[] = [];

async function time<T>(step: string, fn: () => Promise<T>, note?: (r: T) => string): Promise<T> {
  const t = performance.now();
  const r = await fn();
  const ms = Math.round(performance.now() - t);
  const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  results.push({ step, ms, rssMB, note: note?.(r) });
  console.log(`${step}: ${ms}ms rss=${rssMB}MB ${note?.(r) ?? ''}`);
  return r;
}

async function main() {
  const c = new pg.Client({ connectionString: URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  const db = createPool(URL, 10);
  await migrate(db);
  const storage = new LocalStorage(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-load-')));
  const { userId, tenantId } = await registerAccount(db, { email: `load-${Date.now()}@example.test`, password: 'correct-horse-battery', businessName: '負荷試験' }, 'active');
  const wsId = (await db.query(`SELECT active_ws_id FROM tenants WHERE id=$1`, [tenantId])).rows[0].active_ws_id;
  const ctx: Ctx = { db, storage, tenantId, userId, wsId, mode: 'live', now: () => new Date('2026-09-29T03:00:00Z') };

  const { skus, locs, sup } = await time('マスター作成（SKU5,000・場所50・仕入先1）', () =>
    withTx(db, async (tx) => {
      const sup = (await insertSupplier(tx, wsId, { code: 'S1', name: '仕入先', contactName: '', contact: '', leadTimeDays: 7, note: '' })).id;
      const locs: string[] = [];
      for (let i = 0; i < N_LOC; i++) locs.push((await insertLocation(tx, wsId, { code: `L${String(i).padStart(2, '0')}`, name: `棚${i}`, description: '', kind: i === N_LOC - 1 ? 'hold' : 'normal' })).id);
      const skus: string[] = [];
      for (let i = 0; i < N_SKU; i++) {
        skus.push(
          (
            await insertSku(tx, wsId, {
              code: `SKU-${String(i).padStart(5, '0')}`,
              name: `商品${i}`,
              groupName: `G${i % 100}`,
              color: ['黒', '白', '赤'][i % 3],
              size: ['S', 'M', 'L'][i % 3],
              attrs: '',
              category: `C${i % 20}`,
              brand: '',
              unit: '個',
              supplierId: sup,
              memo: '',
              replenish: { safetyStock: 5, reorderPoint: 10, targetStock: 50, minOrderQty: 0, orderMultiple: 5 },
              leadTimeDays: null,
            })
          ).id,
        );
      }
      return { skus, locs, sup };
    }),
  );

  await time('初期在庫（場所0に5,000SKU、25伝票）', async () => {
    for (let i = 0; i < N_SKU; i += 200) {
      await inv.initialStock(ctx, { idempotencyKey: k(), businessDate: TODAY, note: '', lines: skus.slice(i, i + 200).map((s) => ({ skuId: s, locationId: locs[0], qty: 100 })) });
    }
  });

  await time('移動で台帳を積み上げ（約45,000行）', async () => {
    let n = 0;
    let op = 0;
    while (n < 45_000) {
      const from = locs[0];
      const to = locs[1 + (op % (N_LOC - 2))];
      const start = (op * 100) % N_SKU;
      const lines = skus.slice(start, start + 100).map((s) => ({ skuId: s, qty: 1 }));
      await inv.transfer(ctx, { idempotencyKey: k(), businessDate: TODAY, note: '', fromLocationId: from, toLocationId: to, reason: '', lines, expected: [] });
      n += lines.length * 2;
      op++;
    }
    return n;
  });

  await time('発注5,000件（下書き→発注済み）', async () => {
    for (let i = 0; i < N_PO; i++) {
      const d = await po.createDraft(ctx, {
        supplierId: sup,
        dueDate: i % 3 === 0 ? '2026-09-20' : '2026-10-20',
        locationId: locs[0],
        externalRef: '',
        supplierNote: '',
        internalMemo: '',
        replacesPoId: null,
        lines: [{ skuId: skus[i % N_SKU], qty: 10, dueDate: null, locationId: locs[0] }],
      });
      await po.placeOrder(ctx, d.id, { idempotencyKey: k(), version: d.version, orderedDate: TODAY, acknowledgedBasis: {} });
    }
  });

  const counts = (await db.query(`SELECT (SELECT count(*) FROM ledger_events WHERE ws_id=$1)::int le, (SELECT count(*) FROM purchase_orders WHERE ws_id=$1)::int po`, [wsId])).rows[0];
  console.log('規模', counts);
  results.push({ step: `規模：台帳${counts.le}行・発注${counts.po}件・SKU${N_SKU}・場所${N_LOC}`, ms: 0, rssMB: 0 });

  await time('在庫一覧 検索（部分一致・50件）', () => q.listInventory(ctx, { q: '商品12', limit: 50 }), (r) => `${r.rows.length}件`);
  await time('在庫一覧 絞込（補充候補）', () => q.listInventory(ctx, { filter: 'replenish', limit: 50 }), (r) => `${r.rows.length}件`);
  await time('在庫一覧 1ページ目', () => q.listInventory(ctx, { limit: 50 }));
  await time('SKU詳細', () => q.getSku(ctx, skus[1234]));
  await time('SKU履歴（50件）', () => q.listHistory(ctx, { skuId: skus[1234], limit: 50 }));
  await time('全体履歴（50件）', () => q.listHistory(ctx, { limit: 50 }));
  await time('入荷待ち明細（100件）', () => po.listPendingLines(ctx, { limit: 100 }));
  await time('入荷待ち（納期超過）', () => po.listPendingLines(ctx, { overdue: true, limit: 100 }));
  await time('発注一覧（50件）', () => po.listPos(ctx, { status: 'open', limit: 50 }));
  await time('補充候補の計算（全5,000SKU）', () => loadReplenishRows(ctx), (r) => `${r.length}件`);
  await time('ダッシュボード', () => q.dashboard(ctx));
  await time('台帳と残高の照合（全件）', () => q.verifyLedger(ctx), (r) => `ok=${r.ok}`);
  await time('1件出庫の確定', () => inv.issue(ctx, { idempotencyKey: k(), businessDate: TODAY, note: '', purpose: 'sale', externalRef: '', destinationLabel: '', lines: [{ skuId: skus[7], locationId: locs[0], qty: 1 }], expected: [] }));
  await time('CSV出力 入出庫履歴（全期間）', () => exportCsv(ctx, 'history', {}), (r) => `${Math.round(r.csv.length / 1024)}KB`);
  await time('CSV出力 場所別在庫', () => exportCsv(ctx, 'stock', {}), (r) => `${Math.round(r.csv.length / 1024)}KB`);

  const stId = await time('棚卸開始（場所0・5,000SKU）', () => st.startStocktake(ctx, { idempotencyKey: k(), locationId: locs[0], businessDate: TODAY }), (r) => `${r.result.lineCount}行`);
  // 計数入力は試験用に一括（実運用はスマホで1行ずつ）。1%に差異を入れる
  await db.query(`UPDATE stocktake_lines SET counted_qty = CASE WHEN random() < 0.01 THEN theoretical_qty - 1 ELSE theoretical_qty END, reason_code='miscount' WHERE ws_id=$1 AND stocktake_id=$2`, [
    wsId,
    stId.result.id,
  ]);
  await time('棚卸詳細の取得（5,000行）', () => st.getStocktake(ctx, stId.result.id));
  const v = await st.toReview(ctx, stId.result.id, (await st.getStocktake(ctx, stId.result.id)).version);
  await time('棚卸確定（差異一括調整）', () => st.confirmStocktake(ctx, stId.result.id, { idempotencyKey: k(), version: v.version }), (r) => `調整${r.result.adjusted}行`);

  const bk = await time('バックアップ作成（ZIP）', () => exportBackup(ctx), (r) => `${Math.round(fs.statSync(r.filePath).size / 1024)}KB`);
  const stg = await time('復元の検証（別世代へ展開）', () => stageRestore(ctx, bk.filePath));
  await discardStaging(ctx, stg.stagingId);
  await time('台帳と残高の照合（最終）', () => q.verifyLedger(ctx), (r) => `ok=${r.ok}`);

  const env = `Node ${process.version} / PostgreSQL ${(await db.query('SHOW server_version')).rows[0].server_version} / ${os.cpus().length} vCPU / ${Math.round(os.totalmem() / 1024 ** 3)}GB RAM（開発用クラウドコンテナ、DBは同一ホスト）`;
  const md = [`# 負荷測定結果`, ``, `環境：${env}`, `実行日：${new Date().toISOString().slice(0, 10)}`, ``, `| 処理 | 時間(ms) | RSS(MB) | 備考 |`, `|---|---:|---:|---|`, ...results.map((r) => `| ${r.step} | ${r.ms} | ${r.rssMB} | ${r.note ?? ''} |`)].join('\n');
  fs.writeFileSync('docs/LOADTEST_RESULT.md', md + '\n');
  console.log('written docs/LOADTEST_RESULT.md');
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
