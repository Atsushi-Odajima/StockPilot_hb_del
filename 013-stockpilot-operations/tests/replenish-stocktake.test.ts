import { afterAll, describe, expect, it } from 'vitest';
import { newTenant, loc, sku, supplier, key, balance, expectError, closeDb, TODAY } from './helpers.js';
import * as inv from '../src/server/services/inventory.js';
import * as po from '../src/server/services/po.js';
import * as st from '../src/server/services/stocktake.js';
import { computeReplenishment } from '../src/domain/replenish.js';
import { loadReplenishRows, createDraftsFromCandidates } from '../src/server/services/replenish.js';
import { verifyLedger } from '../src/server/services/queries.js';
import { resolveSession, login } from '../src/server/services/auth.js';

afterAll(closeDb);
const d = TODAY;
const S = (reorderPoint: number, targetStock: number, orderMultiple: number, minOrderQty = 0, safetyStock = 0) => ({
  safetyStock,
  reorderPoint,
  targetStock,
  minOrderQty,
  orderMultiple,
});

describe('T14/T15 補充計算（ドメイン）', () => {
  it('U5 O0 発注点10 目標30 単位5 → 25、O20 → 0、O5 → 20', () => {
    expect(computeReplenishment({ available: 5, onOrder: 0, settings: S(10, 30, 5) }).recommended).toBe(25);
    const r2 = computeReplenishment({ available: 5, onOrder: 20, settings: S(10, 30, 5, 0, 8) });
    expect(r2.recommended).toBe(0);
    expect(r2.p).toBe(25);
    expect(r2.belowSafety).toBe(true);
    expect(r2.reason).toContain('20入荷待ち');
    expect(computeReplenishment({ available: 5, onOrder: 5, settings: S(10, 30, 5) }).recommended).toBe(20);
  });
  it('T15 最小発注：U5 O0 発注点10 目標13 最小12 単位5 → 15', () => {
    expect(computeReplenishment({ available: 5, onOrder: 0, settings: S(10, 13, 5, 12) }).recommended).toBe(15);
  });
  it('設定なしは提案しない', () => {
    const r = computeReplenishment({ available: 0, onOrder: 0, settings: null });
    expect(r).toMatchObject({ configured: false, recommended: 0, reason: '補充設定なし' });
  });
  it('発注点ちょうどは補充対象、発注点超は0', () => {
    expect(computeReplenishment({ available: 10, onOrder: 0, settings: S(10, 30, 1) }).recommended).toBe(20);
    expect(computeReplenishment({ available: 11, onOrder: 0, settings: S(10, 30, 1) }).recommended).toBe(0);
  });
});

async function placed(ctx: any, s: string, a: string, qty: number) {
  const sup = await supplier(ctx, 'X' + Math.random().toString(36).slice(2, 7));
  const dr = await po.createDraft(ctx, {
    supplierId: sup,
    dueDate: '2026-03-20',
    locationId: a,
    externalRef: '',
    supplierNote: '',
    internalMemo: '',
    replacesPoId: null,
    lines: [{ skuId: s, qty, dueDate: null, locationId: a }],
  });
  await po.placeOrder(ctx, dr.id, { idempotencyKey: key(), version: dr.version, orderedDate: d, acknowledgedBasis: {} });
  return dr.id;
}

describe('T14/T16 補充（サーバー集計）', () => {
  it('発注残を考慮し、保留は利用可能に含めない', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const h = await loc(ctx, 'H', 'hold');
    const s1 = await sku(ctx, 'S1', { replenish: S(10, 30, 5) });
    const s2 = await sku(ctx, 'S2', { replenish: S(5, 10, 1) });
    await inv.initialStock(ctx, {
      idempotencyKey: key(),
      businessDate: d,
      note: '',
      lines: [
        { skuId: s1, locationId: a, qty: 5 },
        { skuId: s2, locationId: h, qty: 20 },
      ],
    });
    let rows = await loadReplenishRows(ctx);
    expect(rows.find((r) => r.skuId === s1)!.recommended).toBe(25);
    // T16: 通常0、保留20、O0 → 10
    const r2 = rows.find((r) => r.skuId === s2)!;
    expect(r2).toMatchObject({ available: 0, hold: 20, onOrder: 0, recommended: 10 });
    await placed(ctx, s1, a, 20);
    rows = await loadReplenishRows(ctx);
    const r1 = rows.find((r) => r.skuId === s1)!;
    expect(r1).toMatchObject({ available: 5, onOrder: 20, p: 25, recommended: 0 });
    // 納期超過の発注残（納期3/20 < 今日3/31）は別警告として残り、自動で消さない
    expect(r1.overdueOnOrder).toBe(20);
  });
  it('保留場所への発注残は O に含めない', async () => {
    const ctx = await newTenant();
    const h = await loc(ctx, 'H', 'hold');
    const s = await sku(ctx, 'S1', { replenish: S(10, 30, 5) });
    await placed(ctx, s, h, 20);
    const r = (await loadReplenishRows(ctx)).find((x) => x.skuId === s)!;
    expect(r.onOrder).toBe(0);
    expect(r.recommended).toBe(30);
  });
});

describe('T17 発注競合', () => {
  it('補充25の下書き中に別端末で25発注 → 旧下書き確定前に最新状態を示し再確認', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const sup = await supplier(ctx, 'SUPA');
    const s = await sku(ctx, 'S1', { replenish: S(10, 30, 5), supplierId: sup });
    await inv.initialStock(ctx, { idempotencyKey: key(), businessDate: d, note: '', lines: [{ skuId: s, locationId: a, qty: 5 }] });
    const cand = (await loadReplenishRows(ctx)).find((x) => x.skuId === s)!;
    expect(cand.recommended).toBe(25);
    const k = key();
    const cmd = { idempotencyKey: k, items: [{ skuId: s, supplierId: sup, qty: 25, locationId: a, dueDate: null, basisP: cand.p }] };
    const created = await createDraftsFromCandidates(ctx, cmd);
    // 二重タップ：同じキーは1件しか作らない
    const again = await createDraftsFromCandidates(ctx, cmd);
    expect(again.replayed).toBe(true);
    const cnt = await ctx.db.query(`SELECT count(*)::int n FROM purchase_orders WHERE ws_id=$1`, [ctx.wsId]);
    expect(cnt.rows[0].n).toBe(1);
    // 別端末で25を発注済み
    await placed(ctx, s, a, 25);
    const draftId = created.result.created[0].poId;
    const draft = await po.getPo(ctx, draftId);
    const e = await expectError(po.placeOrder(ctx, draftId, { idempotencyKey: key(), version: draft.version, orderedDate: d, acknowledgedBasis: {} }), 'BASIS_CHANGED');
    expect(e.details.changed[0]).toMatchObject({ basisAtDraft: 5, currentP: 30, onOrder: 25 });
    expect((await po.getPo(ctx, draftId)).status).toBe('draft');
    // 最新値を確認した上での明示的な発注は可能
    await po.placeOrder(ctx, draftId, { idempotencyKey: key(), version: draft.version, orderedDate: d, acknowledgedBasis: { [s]: 30 } });
    expect((await po.getPo(ctx, draftId)).status).toBe('placed');
  });
  it('候補表示後に在庫が変わったら下書き作成時に知らせる', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const sup = await supplier(ctx, 'SUPB');
    const s = await sku(ctx, 'S1', { replenish: S(10, 30, 5), supplierId: sup });
    const cand = (await loadReplenishRows(ctx)).find((x) => x.skuId === s)!;
    await inv.outsideReceipt(ctx, { idempotencyKey: key(), businessDate: d, note: '', reason: 'x', externalRef: '', lines: [{ skuId: s, locationId: a, qty: 3 }], expected: [] });
    await expectError(
      createDraftsFromCandidates(ctx, { idempotencyKey: key(), items: [{ skuId: s, supplierId: sup, qty: 30, locationId: a, dueDate: null, basisP: cand.p }] }),
      'BASIS_CHANGED',
    );
  });
});

async function stocktakeSetup(theoretical: number) {
  const ctx = await newTenant();
  const a = await loc(ctx, 'A');
  const b = await loc(ctx, 'B');
  const s = await sku(ctx, 'S1');
  await inv.initialStock(ctx, { idempotencyKey: key(), businessDate: d, note: '', lines: [{ skuId: s, locationId: a, qty: theoretical }] });
  const r = await st.startStocktake(ctx, { idempotencyKey: key(), locationId: a, businessDate: d });
  return { ctx, a, b, s, stId: r.result.id };
}

describe('T18 棚卸', () => {
  it('理論10、実数8、理由入力 → 確定で-2、在庫8。再確定しても8', async () => {
    const { ctx, a, s, stId } = await stocktakeSetup(10);
    let cur = await st.getStocktake(ctx, stId);
    const line = cur.lines[0];
    const c1 = await st.recordCount(ctx, stId, { lineId: line.id, version: line.version, countedQty: 8 });
    await st.setReason(ctx, stId, { lineId: line.id, version: c1.version, reasonCode: 'loss', reasonNote: '' });
    cur = await st.getStocktake(ctx, stId);
    const rv = await st.toReview(ctx, stId, cur.version);
    const k = key();
    const r = await st.confirmStocktake(ctx, stId, { idempotencyKey: k, version: rv.version });
    expect(r.result.adjusted).toBe(1);
    expect(await balance(ctx, s, a)).toBe(8);
    const again = await st.confirmStocktake(ctx, stId, { idempotencyKey: k, version: rv.version });
    expect(again.replayed).toBe(true);
    await expectError(st.confirmStocktake(ctx, stId, { idempotencyKey: key(), version: rv.version }), 'STATE');
    expect(await balance(ctx, s, a)).toBe(8);
    const loc = await ctx.db.query(`SELECT stocktake_id FROM locations WHERE ws_id=$1 AND id=$2`, [ctx.wsId, a]);
    expect(loc.rows[0].stocktake_id).toBeNull();
    const ev = await ctx.db.query(`SELECT qty FROM ledger_events WHERE ws_id=$1 AND kind='stocktake_adjust'`, [ctx.wsId]);
    expect(ev.rows.map((x) => x.qty)).toEqual([-2]);
    expect((await verifyLedger(ctx)).ok).toBe(true);
  });
  it('差異のある行に理由がなければ確定できない', async () => {
    const { ctx, stId } = await stocktakeSetup(10);
    const line = (await st.getStocktake(ctx, stId)).lines[0];
    await st.recordCount(ctx, stId, { lineId: line.id, version: line.version, countedQty: 9 });
    const rv = await st.toReview(ctx, stId, (await st.getStocktake(ctx, stId)).version);
    await expectError(st.confirmStocktake(ctx, stId, { idempotencyKey: key(), version: rv.version }), 'VALIDATION');
  });
  it('差異0は在庫イベントを作らず確認履歴のみ', async () => {
    const { ctx, a, s, stId } = await stocktakeSetup(10);
    const line = (await st.getStocktake(ctx, stId)).lines[0];
    await st.recordCount(ctx, stId, { lineId: line.id, version: line.version, countedQty: 10 });
    const rv = await st.toReview(ctx, stId, (await st.getStocktake(ctx, stId)).version);
    const r = await st.confirmStocktake(ctx, stId, { idempotencyKey: key(), version: rv.version });
    expect(r.result.adjusted).toBe(0);
    expect(await balance(ctx, s, a)).toBe(10);
    expect((await st.getStocktake(ctx, stId)).status).toBe('confirmed');
  });
});

describe('T19 未計数', () => {
  it('実数未入力 → 確定不可。明示0なら差異-10', async () => {
    const { ctx, stId } = await stocktakeSetup(10);
    const cur = await st.getStocktake(ctx, stId);
    await expectError(st.toReview(ctx, stId, cur.version), 'VALIDATION');
    const line = cur.lines[0];
    expect(line.counted).toBeNull();
    const c = await st.recordCount(ctx, stId, { lineId: line.id, version: line.version, countedQty: 0 });
    const after = await st.getStocktake(ctx, stId);
    expect(after.lines[0]).toMatchObject({ counted: 0, diff: -10 });
    await st.setReason(ctx, stId, { lineId: line.id, version: c.version, reasonCode: 'other', reasonNote: '全数不明' });
    const rv = await st.toReview(ctx, stId, (await st.getStocktake(ctx, stId)).version);
    await st.confirmStocktake(ctx, stId, { idempotencyKey: key(), version: rv.version });
  });
});

describe('T20 新発見', () => {
  it('理論0の既存SKUを実数3 → +3。同じSKU行を重複生成しない', async () => {
    const { ctx, a, stId } = await stocktakeSetup(1);
    const s2 = await sku(ctx, 'S2');
    const r1 = await st.addLine(ctx, stId, s2);
    const r2 = await st.addLine(ctx, stId, s2);
    expect(r2.existed).toBe(true);
    expect(r2.lineId).toBe(r1.lineId);
    const cur = await st.getStocktake(ctx, stId);
    expect(cur.lines).toHaveLength(2);
    for (const l of cur.lines) {
      const qty = l.skuId === s2 ? 3 : 1;
      const c = await st.recordCount(ctx, stId, { lineId: l.id, version: l.version, countedQty: qty });
      if (l.skuId === s2) await st.setReason(ctx, stId, { lineId: l.id, version: c.version, reasonCode: 'found', reasonNote: '' });
    }
    const rv = await st.toReview(ctx, stId, (await st.getStocktake(ctx, stId)).version);
    await st.confirmStocktake(ctx, stId, { idempotencyKey: key(), version: rv.version });
    expect(await balance(ctx, s2, a)).toBe(3);
  });
});

describe('T21 棚卸停止', () => {
  it('計数中の場所への入出庫・移動・返品・訂正・取消を全て拒否、他の場所は操作できる', async () => {
    const { ctx, a, b, s } = await (async () => {
      const ctx = await newTenant();
      const a = await loc(ctx, 'A');
      const b = await loc(ctx, 'B');
      const h = await loc(ctx, 'H', 'hold');
      const s = await sku(ctx, 'S1');
      await inv.initialStock(ctx, {
        idempotencyKey: key(),
        businessDate: d,
        note: '',
        lines: [
          { skuId: s, locationId: a, qty: 10 },
          { skuId: s, locationId: b, qty: 10 },
        ],
      });
      return { ctx, a, b, h, s };
    })();
    const out = await inv.issue(ctx, { idempotencyKey: key(), businessDate: d, note: '', purpose: 'sale', externalRef: '', destinationLabel: '', lines: [{ skuId: s, locationId: a, qty: 1 }], expected: [] });
    const rin = await inv.outsideReceipt(ctx, { idempotencyKey: key(), businessDate: d, note: '', reason: 'r', externalRef: '', lines: [{ skuId: s, locationId: a, qty: 1 }], expected: [] });
    await st.startStocktake(ctx, { idempotencyKey: key(), locationId: a, businessDate: d });
    const L = 'LOCATION_LOCKED';
    await expectError(inv.outsideReceipt(ctx, { idempotencyKey: key(), businessDate: d, note: '', reason: 'r', externalRef: '', lines: [{ skuId: s, locationId: a, qty: 1 }], expected: [] }), L);
    await expectError(inv.issue(ctx, { idempotencyKey: key(), businessDate: d, note: '', purpose: 'sale', externalRef: '', destinationLabel: '', lines: [{ skuId: s, locationId: a, qty: 1 }], expected: [] }), L);
    await expectError(inv.transfer(ctx, { idempotencyKey: key(), businessDate: d, note: '', fromLocationId: b, toLocationId: a, reason: '', lines: [{ skuId: s, qty: 1 }], expected: [] }), L);
    await expectError(inv.transfer(ctx, { idempotencyKey: key(), businessDate: d, note: '', fromLocationId: a, toLocationId: b, reason: '', lines: [{ skuId: s, qty: 1 }], expected: [] }), L);
    await expectError(inv.correction(ctx, { idempotencyKey: key(), businessDate: d, note: '', reason: 'r', lines: [{ skuId: s, locationId: a, direction: 'increase', qty: 1 }], expected: [] }), L);
    await expectError(inv.disposal(ctx, { idempotencyKey: key(), businessDate: d, note: '', reason: 'r', lines: [{ skuId: s, locationId: a, qty: 1 }], expected: [] }), L);
    await expectError(inv.reversal(ctx, { idempotencyKey: key(), businessDate: d, note: '', eventId: rin.result.lines[0].eventId, qty: 1, reason: 'r' }), L);
    await expectError(inv.supplierReturn(ctx, { idempotencyKey: key(), businessDate: d, note: '', sourceEventId: rin.result.lines[0].eventId, locationId: a, qty: 1, reason: 'r', externalRef: '', expected: [] }), L);
    expect(out).toBeTruthy();
    // 他の場所は操作できる
    await inv.issue(ctx, { idempotencyKey: key(), businessDate: d, note: '', purpose: 'sale', externalRef: '', destinationLabel: '', lines: [{ skuId: s, locationId: b, qty: 1 }], expected: [] });
    expect(await balance(ctx, s, b)).toBe(9);
    expect(await balance(ctx, s, a)).toBe(10);
    // 同じ場所の二重棚卸も拒否
    await expectError(st.startStocktake(ctx, { idempotencyKey: key(), locationId: a, businessDate: d }), L);
  });
});

describe('T22 棚卸開始競合', () => {
  it('入庫と棚卸開始を同時実行：入庫が先なら基準に含まれ、停止が先なら入庫拒否', async () => {
    for (let round = 0; round < 6; round++) {
      const ctx = await newTenant();
      const a = await loc(ctx, 'A');
      const s = await sku(ctx, 'S1');
      await inv.initialStock(ctx, { idempotencyKey: key(), businessDate: d, note: '', lines: [{ skuId: s, locationId: a, qty: 10 }] });
      const [rcv, start] = await Promise.allSettled([
        inv.outsideReceipt(ctx, { idempotencyKey: key(), businessDate: d, note: '', reason: 'r', externalRef: '', lines: [{ skuId: s, locationId: a, qty: 5 }], expected: [] }),
        st.startStocktake(ctx, { idempotencyKey: key(), locationId: a, businessDate: d }),
      ]);
      expect(start.status).toBe('fulfilled');
      const stId = (start as PromiseFulfilledResult<any>).value.result.id;
      const theo = (await st.getStocktake(ctx, stId)).lines[0].theoretical;
      if (rcv.status === 'fulfilled') {
        expect(theo).toBe(15);
      } else {
        expect((rcv.reason as any).code).toBe('LOCATION_LOCKED');
        expect(theo).toBe(10);
      }
      expect(await balance(ctx, s, a)).toBe(theo);
    }
  });
});

describe('T23 棚卸中止', () => {
  it('入力した実数を在庫へ反映せず停止解除。再ログインでも状況が分かる', async () => {
    const { ctx, a, s, stId } = await stocktakeSetup(10);
    const line = (await st.getStocktake(ctx, stId)).lines[0];
    await st.recordCount(ctx, stId, { lineId: line.id, version: line.version, countedQty: 3 });
    // 再ログイン相当：新しいセッションからも進行中の棚卸が見える
    const email = (await ctx.db.query(`SELECT email FROM users WHERE id=$1`, [ctx.userId])).rows[0].email;
    const lg = await login(ctx.db, email, 'correct-horse-battery', 1);
    const sess = await resolveSession(ctx.db, lg.token);
    expect(sess!.wsId).toBe(ctx.wsId);
    const active = await st.listStocktakes(ctx, { active: true });
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(stId);
    await st.cancelStocktake(ctx, stId, { idempotencyKey: key(), reason: '途中で商品を動かしたため', outsideMovementNote: 'イベント用に2個持ち出し' });
    expect(await balance(ctx, s, a)).toBe(10);
    const loc = await ctx.db.query(`SELECT stocktake_id FROM locations WHERE ws_id=$1 AND id=$2`, [ctx.wsId, a]);
    expect(loc.rows[0].stocktake_id).toBeNull();
    expect((await st.getStocktake(ctx, stId)).status).toBe('cancelled');
    await inv.issue(ctx, { idempotencyKey: key(), businessDate: d, note: '', purpose: 'other', externalRef: '', destinationLabel: '', lines: [{ skuId: s, locationId: a, qty: 1 }], expected: [] });
  });
  it('棚卸行の同時編集はversionで検出し、黙って上書きしない', async () => {
    const { ctx, stId } = await stocktakeSetup(10);
    const line = (await st.getStocktake(ctx, stId)).lines[0];
    await st.recordCount(ctx, stId, { lineId: line.id, version: line.version, countedQty: 9 });
    const e = await expectError(st.recordCount(ctx, stId, { lineId: line.id, version: line.version, countedQty: 7 }), 'VERSION_CONFLICT');
    expect(e.details.countedQty).toBe(9);
  });
  it('再計数で差異確認済みが解除される', async () => {
    const { ctx, stId } = await stocktakeSetup(10);
    const line = (await st.getStocktake(ctx, stId)).lines[0];
    const c = await st.recordCount(ctx, stId, { lineId: line.id, version: line.version, countedQty: 10 });
    await st.toReview(ctx, stId, (await st.getStocktake(ctx, stId)).version);
    expect((await st.getStocktake(ctx, stId)).status).toBe('review');
    await st.recordCount(ctx, stId, { lineId: line.id, version: c.version, countedQty: 9 });
    const cur = await st.getStocktake(ctx, stId);
    expect(cur.status).toBe('counting');
    expect(cur.lines[0].countEdits).toBe(2);
  });
});
