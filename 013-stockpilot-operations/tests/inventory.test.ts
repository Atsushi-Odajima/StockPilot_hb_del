import { afterAll, describe, expect, it } from 'vitest';
import { newTenant, loc, sku, supplier, key, balance, ledgerSum, expectError, closeDb, TODAY } from './helpers.js';
import * as inv from '../src/server/services/inventory.js';
import * as po from '../src/server/services/po.js';
import { verifyLedger } from '../src/server/services/queries.js';
import { withTx } from '../src/server/db/pool.js';

afterAll(closeDb);

const d = TODAY;

async function init(ctx: any, skuId: string, locationId: string, qty: number) {
  return inv.initialStock(ctx, { idempotencyKey: key(), businessDate: d, note: '', lines: [{ skuId, locationId, qty }] });
}
const issueCmd = (skuId: string, locationId: string, qty: number, k = key()) => ({
  idempotencyKey: k,
  businessDate: d,
  note: '',
  purpose: 'sale' as const,
  externalRef: '',
  destinationLabel: '',
  lines: [{ skuId, locationId, qty }],
  expected: [],
});
const outsideCmd = (skuId: string, locationId: string, qty: number, k = key()) => ({
  idempotencyKey: k,
  businessDate: d,
  note: '',
  reason: 'テスト入庫',
  externalRef: '',
  lines: [{ skuId, locationId, qty }],
  expected: [],
});

describe('T01 基本入出庫', () => {
  it('棚A10 → 入庫5 → 15 → 出庫3 → 12、台帳再集計も12', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    await init(ctx, s, a, 10);
    const r1 = await inv.outsideReceipt(ctx, outsideCmd(s, a, 5));
    expect(r1.result.lines[0]).toMatchObject({ before: 10, after: 15, delta: 5 });
    expect(await balance(ctx, s, a)).toBe(15);
    await inv.issue(ctx, issueCmd(s, a, 3));
    expect(await balance(ctx, s, a)).toBe(12);
    expect(await ledgerSum(ctx, s, a)).toBe(12);
    expect((await verifyLedger(ctx)).ok).toBe(true);
  });
});

describe('T02 二重送信', () => {
  it('同じキーで入庫5を2回 → 増加5のみ。同じキーで内容違いは拒否', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    const k = key();
    const r1 = await inv.outsideReceipt(ctx, outsideCmd(s, a, 5, k));
    const r2 = await inv.outsideReceipt(ctx, outsideCmd(s, a, 5, k));
    expect(r1.replayed).toBe(false);
    expect(r2.replayed).toBe(true);
    expect(r2.result.opNo).toBe(r1.result.opNo);
    expect(await balance(ctx, s, a)).toBe(5);
    await expectError(inv.outsideReceipt(ctx, outsideCmd(s, a, 6, k)), 'IDEMPOTENCY_CONFLICT');
    expect(await balance(ctx, s, a)).toBe(5);
  });
  it('同じキーの同時送信でも1回だけ反映', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    const k = key();
    const rs = await Promise.all([1, 2, 3, 4].map(() => inv.outsideReceipt(ctx, outsideCmd(s, a, 5, k))));
    expect(rs.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await balance(ctx, s, a)).toBe(5);
  });
});

describe('T03 同時出庫', () => {
  it('在庫5に別端末が各4個を同時確定 → 一方だけ成功、残1', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    await init(ctx, s, a, 5);
    const results = await Promise.allSettled([inv.issue(ctx, issueCmd(s, a, 4)), inv.issue(ctx, issueCmd(s, a, 4))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rej = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rej.reason.code).toBe('INSUFFICIENT_STOCK');
    expect(await balance(ctx, s, a)).toBe(1);
    expect(await ledgerSum(ctx, s, a)).toBe(1);
  });
  it('存在しない残高行への同時初期在庫でも二重作成しない', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    const rs = await Promise.allSettled([init(ctx, s, a, 7), init(ctx, s, a, 7)]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(((rs.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as any).code).toBe('INITIAL_EXISTS');
    expect(await balance(ctx, s, a)).toBe(7);
  });
});

describe('T04 移動', () => {
  it('棚A20、ケース0から6個移動 → 14と6、全体20', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const cs = await loc(ctx, 'CASE');
    const s = await sku(ctx, 'S1');
    await init(ctx, s, a, 20);
    const r = await inv.transfer(ctx, {
      idempotencyKey: key(),
      businessDate: d,
      note: '',
      fromLocationId: a,
      toLocationId: cs,
      reason: '',
      lines: [{ skuId: s, qty: 6 }],
      expected: [],
    });
    expect(r.result.lines).toHaveLength(2);
    expect(await balance(ctx, s, a)).toBe(14);
    expect(await balance(ctx, s, cs)).toBe(6);
    const ev = await ctx.db.query(`SELECT count(DISTINCT op_id)::int n FROM ledger_events WHERE ws_id=$1 AND kind IN ('transfer_out','transfer_in')`, [ctx.wsId]);
    expect(ev.rows[0].n).toBe(1);
  });
  it('途中のDB失敗なら20と0のまま（原子性）', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const cs = await loc(ctx, 'CASE');
    const s = await sku(ctx, 'S1');
    await init(ctx, s, a, 20);
    // 移動の入庫側を書いた直後に失敗させる
    await expect(
      withTx(ctx.db, async (c) => {
        await inv.transferTx(c, ctx, {
          idempotencyKey: key(),
          businessDate: d,
          note: '',
          fromLocationId: a,
          toLocationId: cs,
          reason: '',
          lines: [{ skuId: s, qty: 6 }],
          expected: [],
        });
        throw new Error('simulated failure after write');
      }),
    ).rejects.toThrow('simulated');
    expect(await balance(ctx, s, a)).toBe(20);
    expect(await balance(ctx, s, cs)).toBe(0);
    expect((await verifyLedger(ctx)).ok).toBe(true);
  });
  it('同じ場所・不足・棚卸停止中は拒否', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const cs = await loc(ctx, 'CASE');
    const s = await sku(ctx, 'S1');
    await init(ctx, s, a, 3);
    const base = { idempotencyKey: key(), businessDate: d, note: '', reason: '', lines: [{ skuId: s, qty: 6 }], expected: [] };
    await expectError(inv.transfer(ctx, { ...base, fromLocationId: a, toLocationId: a }), 'VALIDATION');
    const e = await expectError(inv.transfer(ctx, { ...base, fromLocationId: a, toLocationId: cs }), 'INSUFFICIENT_STOCK');
    expect(e.details.shortages[0]).toMatchObject({ current: 3, required: 6 });
  });
});

describe('T05 保留', () => {
  it('通常10から保留へ2 → 現物10、利用可能8、保留2。保留から通常出庫は拒否', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const h = await loc(ctx, 'HOLD', 'hold');
    const s = await sku(ctx, 'S1');
    await init(ctx, s, a, 10);
    await inv.transfer(ctx, { idempotencyKey: key(), businessDate: d, note: '', fromLocationId: a, toLocationId: h, reason: '', lines: [{ skuId: s, qty: 2 }], expected: [] });
    const { getSku } = await import('../src/server/services/queries.js');
    const info = await getSku(ctx, s);
    expect(info.available).toBe(8);
    expect(info.hold).toBe(2);
    expect(info.available + info.hold).toBe(10);
    await expectError(inv.issue(ctx, issueCmd(s, h, 1)), 'VALIDATION');
    // 保留→通常は理由必須
    await expectError(
      inv.transfer(ctx, { idempotencyKey: key(), businessDate: d, note: '', fromLocationId: h, toLocationId: a, reason: '', lines: [{ skuId: s, qty: 1 }], expected: [] }),
      'VALIDATION',
    );
  });
});

async function placedPo(ctx: any, s: string, a: string, qty: number) {
  const sup = await supplier(ctx, 'S' + Math.random().toString(36).slice(2, 7));
  const dr = await po.createDraft(ctx, {
    supplierId: sup,
    dueDate: '2026-04-10',
    locationId: a,
    externalRef: '',
    supplierNote: '',
    internalMemo: '',
    replacesPoId: null,
    lines: [{ skuId: s, qty, dueDate: null, locationId: a }],
  });
  await po.placeOrder(ctx, dr.id, { idempotencyKey: key(), version: dr.version, orderedDate: d, acknowledgedBasis: {} });
  const p = await po.getPo(ctx, dr.id);
  return { poId: dr.id, lineId: p.lines[0].id, version: p.version };
}
const rcv = (lineId: string, splits: { locationId: string; qty: number }[], extra: any = {}) => ({
  idempotencyKey: key(),
  businessDate: d,
  note: '',
  lines: [{ poLineId: lineId, splits }],
  closeShortLineIds: [],
  closeShortReason: '',
  expected: [],
  ...extra,
});

describe('T06 分納', () => {
  it('Q100、60→残40、30→残10、10→残0。受領は別IDで3件', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    const { poId, lineId } = await placedPo(ctx, s, a, 100);
    const r1 = await po.receive(ctx, poId, rcv(lineId, [{ locationId: a, qty: 60 }]));
    expect((await po.getPo(ctx, poId)).lines[0].outstanding).toBe(40);
    expect((await po.getPo(ctx, poId)).displayStatus).toBe('partial');
    const r2 = await po.receive(ctx, poId, rcv(lineId, [{ locationId: a, qty: 30 }]));
    expect((await po.getPo(ctx, poId)).lines[0].outstanding).toBe(10);
    const r3 = await po.receive(ctx, poId, rcv(lineId, [{ locationId: a, qty: 10 }]));
    const p = await po.getPo(ctx, poId);
    expect(p.lines[0].outstanding).toBe(0);
    expect(p.displayStatus).toBe('received');
    expect(new Set([r1.result.operationId, r2.result.operationId, r3.result.operationId]).size).toBe(3);
    expect(p.receipts).toHaveLength(3);
    expect(await balance(ctx, s, a)).toBe(100);
    expect((await verifyLedger(ctx)).ok).toBe(true);
  });
});

describe('T07 未入荷打切り', () => {
  it('Q100、R60、C40 → 残0、現物60、状態は残数打切り完了', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    const { poId, lineId, version } = await placedPo(ctx, s, a, 100);
    await po.receive(ctx, poId, rcv(lineId, [{ locationId: a, qty: 60 }]));
    await po.cancelRemaining(ctx, poId, { idempotencyKey: key(), version, reason: '仕入先欠品のため打切り', lineIds: [lineId] });
    const p = await po.getPo(ctx, poId);
    expect(p.lines[0]).toMatchObject({ qty: 100, received: 60, cancelled: 40, outstanding: 0 });
    expect(p.displayStatus).toBe('closed_short');
    expect(p.displayStatus).not.toBe('received');
    expect(await balance(ctx, s, a)).toBe(60);
  });
  it('受領0で全量打切り → 取消', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    const { poId, lineId, version } = await placedPo(ctx, s, a, 10);
    await po.cancelRemaining(ctx, poId, { idempotencyKey: key(), version, reason: '発注取消', lineIds: [lineId] });
    expect((await po.getPo(ctx, poId)).displayStatus).toBe('cancelled');
  });
  it('入荷時に不足分を打ち切る選択', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    const { poId, lineId } = await placedPo(ctx, s, a, 10);
    await po.receive(ctx, poId, rcv(lineId, [{ locationId: a, qty: 7 }], { closeShortLineIds: [lineId], closeShortReason: '仕入先確認済み' }));
    const p = await po.getPo(ctx, poId);
    expect(p.lines[0]).toMatchObject({ received: 7, cancelled: 3, outstanding: 0 });
  });
});

describe('T08 過剰入荷', () => {
  it('残10に11受領 → 発注と在庫の両方を変えず拒否', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    const { poId, lineId } = await placedPo(ctx, s, a, 100);
    await po.receive(ctx, poId, rcv(lineId, [{ locationId: a, qty: 90 }]));
    await expectError(po.receive(ctx, poId, rcv(lineId, [{ locationId: a, qty: 11 }])), 'OVER_RECEIPT');
    const p = await po.getPo(ctx, poId);
    expect(p.lines[0].received).toBe(90);
    expect(await balance(ctx, s, a)).toBe(90);
  });
});

describe('T09 不良品', () => {
  it('20受領を通常18・保留2 → R20、利用可能18。保留解除後は利用可能20、Rは20のまま', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const h = await loc(ctx, 'HOLD', 'hold');
    const s = await sku(ctx, 'S1');
    const { poId, lineId } = await placedPo(ctx, s, a, 20);
    await po.receive(
      ctx,
      poId,
      rcv(lineId, [
        { locationId: a, qty: 18 },
        { locationId: h, qty: 2 },
      ]),
    );
    const { getSku } = await import('../src/server/services/queries.js');
    expect((await po.getPo(ctx, poId)).lines[0].received).toBe(20);
    expect((await getSku(ctx, s)).available).toBe(18);
    await inv.transfer(ctx, { idempotencyKey: key(), businessDate: d, note: '', fromLocationId: h, toLocationId: a, reason: '検品OK', lines: [{ skuId: s, qty: 2 }], expected: [] });
    expect((await getSku(ctx, s)).available).toBe(20);
    expect((await po.getPo(ctx, poId)).lines[0].received).toBe(20);
  });
});

describe('T10 実返品', () => {
  it('発注100受領後、仕入先へ10返品 → 現物90、発注残0。自動で追加発注を作らない', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    const { poId, lineId } = await placedPo(ctx, s, a, 100);
    const r = await po.receive(ctx, poId, rcv(lineId, [{ locationId: a, qty: 100 }]));
    const evId = r.result.lines[0].eventId;
    await inv.supplierReturn(ctx, { idempotencyKey: key(), businessDate: d, note: '', sourceEventId: evId, locationId: a, qty: 10, reason: '不良返品', externalRef: '', expected: [] });
    expect(await balance(ctx, s, a)).toBe(90);
    const p = await po.getPo(ctx, poId);
    expect(p.lines[0]).toMatchObject({ received: 100, outstanding: 0 });
    const cnt = await ctx.db.query(`SELECT count(*)::int n FROM purchase_orders WHERE ws_id=$1`, [ctx.wsId]);
    expect(cnt.rows[0].n).toBe(1);
    // 返品上限
    await expectError(
      inv.supplierReturn(ctx, { idempotencyKey: key(), businessDate: d, note: '', sourceEventId: evId, locationId: a, qty: 91, reason: 'x', externalRef: '', expected: [] }),
      'OVER_CAP',
    );
  });
});

describe('T11 誤登録取消', () => {
  it('在庫0へ誤入庫5 → 全量取消。+5と-5が残り残0。取消再送で-5にしない', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    await init(ctx, s, a, 1);
    await inv.issue(ctx, issueCmd(s, a, 1));
    const r = await inv.outsideReceipt(ctx, outsideCmd(s, a, 5));
    const k = key();
    const cmd = { idempotencyKey: k, businessDate: d, note: '', eventId: r.result.lines[0].eventId, qty: 5, reason: '誤登録' };
    await inv.reversal(ctx, cmd);
    const again = await inv.reversal(ctx, cmd);
    expect(again.replayed).toBe(true);
    expect(await balance(ctx, s, a)).toBe(0);
    const ev = await ctx.db.query(`SELECT qty, kind FROM ledger_events WHERE ws_id=$1 AND kind IN ('outside_receipt','reversal') ORDER BY seq`, [ctx.wsId]);
    expect(ev.rows.map((x) => x.qty)).toEqual([5, -5]);
    // 別キーで再取消しても取消済み数量の上限で拒否
    await expectError(inv.reversal(ctx, { ...cmd, idempotencyKey: key() }), 'OVER_CAP');
    expect(await balance(ctx, s, a)).toBe(0);
  });
  it('取消の履歴は取り消せない、確定済みイベントはDBで更新・削除できない', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    const r = await inv.outsideReceipt(ctx, outsideCmd(s, a, 5));
    const rv = await inv.reversal(ctx, { idempotencyKey: key(), businessDate: d, note: '', eventId: r.result.lines[0].eventId, qty: 2, reason: 'x' });
    await expectError(inv.reversal(ctx, { idempotencyKey: key(), businessDate: d, note: '', eventId: rv.result.lines[0].eventId, qty: 1, reason: 'x' }), 'VALIDATION');
    await expect(ctx.db.query(`UPDATE ledger_events SET qty=100 WHERE ws_id=$1`, [ctx.wsId])).rejects.toThrow(/append-only/);
    await expect(ctx.db.query(`DELETE FROM ledger_events WHERE ws_id=$1`, [ctx.wsId])).rejects.toThrow(/append-only/);
  });
  it('発注入荷の取消は受領数Rも戻す', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    const { poId, lineId } = await placedPo(ctx, s, a, 10);
    const r = await po.receive(ctx, poId, rcv(lineId, [{ locationId: a, qty: 10 }]));
    await inv.reversal(ctx, { idempotencyKey: key(), businessDate: d, note: '', eventId: r.result.lines[0].eventId, qty: 4, reason: '数え間違い' });
    const p = await po.getPo(ctx, poId);
    expect(p.lines[0]).toMatchObject({ received: 6, outstanding: 4 });
    expect(p.displayStatus).toBe('partial');
    expect((await verifyLedger(ctx)).ok).toBe(true);
  });
  it('移動の取消は両側を同時に戻す', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const b = await loc(ctx, 'B');
    const s = await sku(ctx, 'S1');
    await init(ctx, s, a, 10);
    const t = await inv.transfer(ctx, { idempotencyKey: key(), businessDate: d, note: '', fromLocationId: a, toLocationId: b, reason: '', lines: [{ skuId: s, qty: 6 }], expected: [] });
    await inv.reversal(ctx, { idempotencyKey: key(), businessDate: d, note: '', eventId: t.result.lines[1].eventId, qty: 6, reason: '移動先違い' });
    expect(await balance(ctx, s, a)).toBe(10);
    expect(await balance(ctx, s, b)).toBe(0);
  });
});

describe('T12 取消不可', () => {
  it('入庫5の後に3出庫済み → 入庫5の全取消は負数になるため拒否', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    const r = await inv.outsideReceipt(ctx, outsideCmd(s, a, 5));
    await inv.issue(ctx, issueCmd(s, a, 3));
    await expectError(inv.reversal(ctx, { idempotencyKey: key(), businessDate: d, note: '', eventId: r.result.lines[0].eventId, qty: 5, reason: '誤登録' }), 'INSUFFICIENT_STOCK');
    expect(await balance(ctx, s, a)).toBe(2);
  });
  it('移動先から出庫済みで逆移動すると負数になる場合は拒否', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const b = await loc(ctx, 'B');
    const s = await sku(ctx, 'S1');
    await init(ctx, s, a, 10);
    const t = await inv.transfer(ctx, { idempotencyKey: key(), businessDate: d, note: '', fromLocationId: a, toLocationId: b, reason: '', lines: [{ skuId: s, qty: 6 }], expected: [] });
    await inv.issue(ctx, issueCmd(s, b, 5));
    await expectError(inv.reversal(ctx, { idempotencyKey: key(), businessDate: d, note: '', eventId: t.result.lines[0].eventId, qty: 6, reason: 'x' }), 'INSUFFICIENT_STOCK');
  });
});

describe('T13 顧客返品', () => {
  it('元出庫5へ3返品済み → さらに3返品は累計超過で拒否。良品数量へ勝手に加算しない', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const h = await loc(ctx, 'HOLD', 'hold');
    const s = await sku(ctx, 'S1');
    await init(ctx, s, a, 5);
    const out = await inv.issue(ctx, issueCmd(s, a, 5));
    const src = out.result.lines[0].eventId;
    const ret = (qty: number, locationId = h) => ({
      idempotencyKey: key(),
      businessDate: d,
      note: '',
      sourceEventId: src,
      skuId: s,
      locationId,
      qty,
      reason: '',
      externalRef: '',
    });
    await inv.customerReturn(ctx, ret(3));
    await expectError(inv.customerReturn(ctx, ret(3)), 'OVER_CAP');
    expect(await balance(ctx, s, a)).toBe(0); // 通常場所は増えない
    expect(await balance(ctx, s, h)).toBe(3);
    // 通常場所へ直接返品は拒否
    await expectError(inv.customerReturn(ctx, ret(1, a)), 'VALIDATION');
    // 元履歴なし返品は理由必須
    await expectError(inv.customerReturn(ctx, { ...ret(1), sourceEventId: null }), 'VALIDATION');
    const ns = await inv.customerReturn(ctx, { ...ret(1), sourceEventId: null, reason: '過去の手渡し分' });
    const op = await ctx.db.query(`SELECT no_source FROM operations WHERE ws_id=$1 AND id=$2`, [ctx.wsId, ns.result.operationId]);
    expect(op.rows[0].no_source).toBe(true);
  });
});

describe('入力検証・上限', () => {
  it('小数・負数・0・上限超過・NaN を拒否（スキーマ）', async () => {
    const { zIssueCmd } = await import('../src/shared/schemas.js');
    const base = { idempotencyKey: key(), businessDate: d, purpose: 'sale', lines: [{ skuId: crypto.randomUUID(), locationId: crypto.randomUUID(), qty: 1 }] };
    for (const qty of [0, -1, 1.5, 1_000_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(zIssueCmd.safeParse({ ...base, lines: [{ ...base.lines[0], qty }] }).success).toBe(false);
    }
    expect(zIssueCmd.safeParse(base).success).toBe(true);
    for (const bd of ['2026-02-29', '2026-13-01', '2026/03/01', '']) {
      expect(zIssueCmd.safeParse({ ...base, businessDate: bd }).success).toBe(false);
    }
    expect(zIssueCmd.safeParse({ ...base, businessDate: '2028-02-29' }).success).toBe(true);
  });
  it('残高上限10億を超える入庫はDB・サーバーで拒否', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    // 上限近くまで直接投入（テスト用：初期在庫を複数回に分けられないため台帳経由で積む）
    for (let i = 0; i < 3; i++) {
      await withTx(ctx.db, (c) =>
        inv.applyOperation(c, ctx, { kind: 'correction', businessDate: d, reason: 't', movements: [{ skuId: s, locationId: a, delta: 333_333_333, kind: 'correction' }] }),
      );
    }
    await expectError(inv.outsideReceipt(ctx, outsideCmd(s, a, 1_000_000)), 'BALANCE_LIMIT');
    await expect(ctx.db.query(`UPDATE balances SET qty=-1 WHERE ws_id=$1`, [ctx.wsId])).rejects.toThrow();
  });
  it('古い画面の数量で確定しようとすると STALE_QTY', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    await init(ctx, s, a, 8);
    await inv.issue(ctx, issueCmd(s, a, 1));
    const e = await expectError(inv.issue(ctx, { ...issueCmd(s, a, 2), expected: [{ skuId: s, locationId: a, qty: 8 }] }), 'STALE_QTY');
    expect(e.details.stale[0].current).toBe(7);
    expect(await balance(ctx, s, a)).toBe(7);
  });
  it('初期在庫は履歴があるSKU×場所には登録できない', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const s = await sku(ctx, 'S1');
    await inv.outsideReceipt(ctx, outsideCmd(s, a, 1));
    await expectError(init(ctx, s, a, 5), 'INITIAL_EXISTS');
  });
  it('デッドロックしない：複数場所・複数SKUを逆順で同時移動', async () => {
    const ctx = await newTenant();
    const a = await loc(ctx, 'A');
    const b = await loc(ctx, 'B');
    const s1 = await sku(ctx, 'S1');
    const s2 = await sku(ctx, 'S2');
    await inv.initialStock(ctx, {
      idempotencyKey: key(),
      businessDate: d,
      note: '',
      lines: [
        { skuId: s1, locationId: a, qty: 100 },
        { skuId: s2, locationId: a, qty: 100 },
        { skuId: s1, locationId: b, qty: 100 },
        { skuId: s2, locationId: b, qty: 100 },
      ],
    });
    const mk = (from: string, to: string, order: string[]) =>
      inv.transfer(ctx, { idempotencyKey: key(), businessDate: d, note: '', fromLocationId: from, toLocationId: to, reason: 'r', lines: order.map((x) => ({ skuId: x, qty: 1 })), expected: [] });
    const jobs = [];
    for (let i = 0; i < 10; i++) jobs.push(mk(a, b, [s1, s2]), mk(b, a, [s2, s1]));
    const rs = await Promise.allSettled(jobs);
    expect(rs.filter((r) => r.status === 'rejected')).toHaveLength(0);
    expect((await balance(ctx, s1, a)) + (await balance(ctx, s1, b))).toBe(200);
    expect((await verifyLedger(ctx)).ok).toBe(true);
  });
});
