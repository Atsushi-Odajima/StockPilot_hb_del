// サンプル専用領域（本番とは別ワークスペース）。架空データのみ。本番在庫を上書きしない。
// 期待結果は docs/SAMPLE_DATA.md に記載。
import type { Db } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import type { Storage } from '../storage.js';
import { type Ctx, uuid, today } from './context.js';
import { insertLocation, insertSku, insertSupplier, insertSkuCode } from './masters.js';
import * as inv from './inventory.js';
import * as po from './po.js';
import * as st from './stocktake.js';
import { addDays } from '../../shared/dates.js';
import { computeGtinCheckDigit } from '../../shared/codes.js';

const k = () => uuid();

type Rep = { safetyStock: number; reorderPoint: number; targetStock: number; minOrderQty: number; orderMultiple: number } | null;
const rep = (safetyStock: number, reorderPoint: number, targetStock: number, orderMultiple = 1, minOrderQty = 0): Rep => ({
  safetyStock,
  reorderPoint,
  targetStock,
  minOrderQty,
  orderMultiple,
});

// 架空の JAN（GS1 事業者コードに使われない "20" 始まり＝インストアコード帯で生成）
const fakeJan = (n: number) => {
  const body = `20${String(n).padStart(10, '0')}`;
  return body + computeGtinCheckDigit(body);
};

export async function createSampleWorkspace(db: Db, storage: Storage, tenantId: string, userId: string, now: () => Date = () => new Date()) {
  const wsId = uuid();
  const old = await withTx(db, async (c) => {
    const t = await c.query(`SELECT sample_ws_id FROM tenants WHERE id=$1 FOR UPDATE`, [tenantId]);
    await c.query(`INSERT INTO workspaces (id, tenant_id, kind, label) VALUES ($1,$2,'sample','サンプル')`, [wsId, tenantId]);
    await c.query(`UPDATE tenants SET sample_ws_id=$2 WHERE id=$1`, [tenantId, wsId]);
    return t.rows[0].sample_ws_id as string | null;
  });
  if (old) await db.query(`DELETE FROM workspaces WHERE id=$1 AND tenant_id=$2 AND kind='sample'`, [old, tenantId]);
  const ctx: Ctx = { db, storage, tenantId, userId, wsId, mode: 'sample', now };
  try {
    await seed(ctx);
  } catch (e) {
    await db.query(`UPDATE tenants SET sample_ws_id=NULL WHERE id=$1 AND sample_ws_id=$2`, [tenantId, wsId]);
    await db.query(`DELETE FROM workspaces WHERE id=$1`, [wsId]);
    throw e;
  }
  return wsId;
}

async function seed(ctx: Ctx) {
  const t = today(ctx);
  const d = (n: number) => addDays(t, n);
  const ids = await withTx(ctx.db, async (c) => {
    const W = ctx.wsId;
    const supA = (await insertSupplier(c, W, { code: 'SUP-A', name: 'サンプル衣料卸（架空）', contactName: '山田', contact: 'sample-a@example.invalid', leadTimeDays: 14, note: '' })).id;
    const supB = (await insertSupplier(c, W, { code: 'SUP-B', name: 'サンプル雑貨商会（架空）', contactName: '佐藤', contact: '', leadTimeDays: 7, note: '' })).id;
    const supC = (await insertSupplier(c, W, { code: 'SUP-C', name: 'サンプル印刷所（架空）', contactName: '', contact: '', leadTimeDays: 10, note: '' })).id;
    const A = (await insertLocation(c, W, { code: 'SHELF-A', name: '棚A', description: '通常の保管棚', kind: 'normal' })).id;
    const B = (await insertLocation(c, W, { code: 'SHELF-B', name: '棚B', description: '小物の保管棚', kind: 'normal' })).id;
    const E = (await insertLocation(c, W, { code: 'EVENT', name: 'イベントケース', description: '出店用に持ち出すケース', kind: 'normal' })).id;
    const H = (await insertLocation(c, W, { code: 'HOLD', name: '検品保留箱', description: '破損・返品直後の商品を一時保管', kind: 'hold' })).id;
    const defs: [string, string, string, string, string, string, string | null, Rep, string?][] = [
      // code, name, group, color, size, category, supplier, replenish, unit
      ['TS-BK-M', 'Tシャツ', 'Tシャツ', '黒', 'M', '衣料', supA, rep(5, 10, 30, 5)],
      ['TS-BK-L', 'Tシャツ', 'Tシャツ', '黒', 'L', '衣料', supA, rep(5, 10, 30, 5)],
      ['TS-WH-M', 'Tシャツ', 'Tシャツ', '白', 'M', '衣料', supA, rep(8, 10, 30, 5)],
      ['TS-WH-L', 'Tシャツ', 'Tシャツ', '白', 'L', '衣料', supA, rep(5, 10, 30, 5)],
      ['TS-NV-S', 'Tシャツ', 'Tシャツ', 'ネイビー', 'S', '衣料', supA, null],
      ['HD-GY-M', 'パーカー', 'パーカー', 'グレー', 'M', '衣料', supA, rep(3, 6, 20, 1)],
      ['HD-GY-L', 'パーカー', 'パーカー', 'グレー', 'L', '衣料', supA, rep(3, 6, 20, 1)],
      ['MG-WH', 'マグカップ', 'マグカップ', '白', '', '雑貨', supB, rep(3, 5, 12, 6)],
      ['MG-BK', 'マグカップ', 'マグカップ', '黒', '', '雑貨', supB, rep(3, 5, 12, 6)],
      ['TB-NT', 'トートバッグ', 'トートバッグ', 'ナチュラル', '', '雑貨', supB, rep(4, 8, 20, 10)],
      ['TB-BK', 'トートバッグ', 'トートバッグ', '黒', '', '雑貨', supB, rep(4, 8, 20, 10)],
      ['ST-LOGO', 'ステッカー ロゴ', 'ステッカー', '', '', '紙もの', supC, rep(20, 40, 100, 50, 100), '枚'],
      ['ST-CAT', 'ステッカー ねこ', 'ステッカー', '', '', '紙もの', supC, rep(20, 40, 100, 50, 100), '枚'],
      ['ST-SET', 'ステッカー 5枚セット', 'ステッカー', '', '', '紙もの', supC, null, 'セット'],
      ['PC-A', 'ポストカード A', 'ポストカード', '', '', '紙もの', supC, rep(10, 20, 60, 10), '枚'],
      ['PC-B', 'ポストカード B', 'ポストカード', '', '', '紙もの', supC, rep(10, 20, 60, 10), '枚'],
      ['KH-01', 'キーホルダー 01', 'キーホルダー', '', '', '雑貨', supB, null],
      ['BD-S', '缶バッジ', '缶バッジ', '', 'S', '雑貨', supB, rep(10, 15, 50, 10)],
      ['BD-L', '缶バッジ', '缶バッジ', '', 'L', '雑貨', supB, rep(10, 15, 50, 10)],
      ['NB-A5', 'ノート', 'ノート', '', 'A5', '紙もの', supC, null, '冊'],
      ['PN-BK', 'ボールペン 黒', 'ペン', '黒', '', '雑貨', supB, null, '本'],
      ['TW-01', '手ぬぐい', '手ぬぐい', '', '', '衣料', supA, null, '枚'],
    ];
    const S: Record<string, string> = {};
    let n = 1;
    for (const [code, name, group, color, size, category, supplierId, r, unit] of defs) {
      S[code] = (
        await insertSku(c, W, {
          code,
          name,
          groupName: group,
          color,
          size,
          attrs: '',
          category,
          brand: 'サンプル',
          unit: unit ?? '個',
          supplierId,
          memo: '【サンプル内部メモ】この内容は帳票に出ません',
          replenish: r,
          leadTimeDays: null,
        })
      ).id;
      await insertSkuCode(c, W, S[code], fakeJan(n++), 'JAN13');
    }
    return { supA, supB, supC, A, B, E, H, S };
  });
  const { supA, supB, supC, A, B, E, H, S } = ids;
  const init = (lines: [string, string, number][]) =>
    inv.initialStock(ctx, { idempotencyKey: k(), businessDate: d(-30), note: 'サンプル初期在庫', lines: lines.map(([s, l, q]) => ({ skuId: S[s], locationId: l, qty: q })) });
  await init([
    ['TS-BK-M', A, 5],
    ['TS-BK-L', A, 18],
    ['TS-WH-M', A, 5],
    ['TS-WH-L', A, 14],
    ['TS-NV-S', A, 6],
    ['HD-GY-M', A, 2],
    ['HD-GY-L', A, 9],
    ['MG-WH', B, 10],
    ['MG-BK', B, 2],
    ['TB-NT', A, 3],
    ['TB-BK', A, 12],
    ['ST-LOGO', B, 120],
    ['ST-CAT', B, 80],
    ['ST-SET', B, 30],
    ['PC-A', B, 45],
    ['KH-01', B, 12],
    ['BD-S', B, 40],
    ['BD-L', B, 25],
    ['NB-A5', B, 8],
    ['PN-BK', B, 50],
    ['TW-01', A, 7],
  ]);
  const draft = async (supplierId: string, due: string, lines: [string, number, string][]) =>
    po.createDraft(ctx, {
      supplierId,
      dueDate: due,
      locationId: A,
      externalRef: '',
      supplierNote: '段ボールに発注番号の記載をお願いします。',
      internalMemo: '【サンプル内部メモ】帳票に出ない',
      replacesPoId: null,
      lines: lines.map(([s, q, l]) => ({ skuId: S[s], qty: q, dueDate: null, locationId: l })),
    });
  const place = async (id: string, orderedDate: string) => po.placeOrder(ctx, id, { idempotencyKey: k(), version: 1, orderedDate, acknowledgedBasis: {} });

  // 発注済みで追加不要（TS-WH-M：手元5、入荷待ち20）
  const p1 = await draft(supA, d(7), [['TS-WH-M', 20, A]]);
  await place(p1.id, d(-3));
  // 一部入荷（HD-GY-M：30発注→18入荷、残12）＋ 検品保留（TB-BK：20入荷のうち2を保留）
  const p2 = await draft(supA, d(3), [
    ['HD-GY-M', 30, A],
    ['HD-GY-L', 10, A],
  ]);
  await place(p2.id, d(-10));
  const p2d = await po.getPo(ctx, p2.id);
  await po.receive(ctx, p2.id, {
    idempotencyKey: k(),
    businessDate: d(-2),
    note: '1回目の分納',
    lines: [{ poLineId: p2d.lines[0].id, splits: [{ locationId: A, qty: 18 }] }],
    closeShortLineIds: [],
    closeShortReason: '',
    expected: [],
  });
  const p3 = await draft(supB, d(-2), [['TB-BK', 20, A]]);
  await place(p3.id, d(-9));
  const p3d = await po.getPo(ctx, p3.id);
  await po.receive(ctx, p3.id, {
    idempotencyKey: k(),
    businessDate: d(-3),
    note: '2個に汚れ',
    lines: [
      {
        poLineId: p3d.lines[0].id,
        splits: [
          { locationId: A, qty: 18 },
          { locationId: H, qty: 2 },
        ],
      },
    ],
    closeShortLineIds: [],
    closeShortReason: '',
    expected: [],
  });
  // 納期超過（TB-NT：納期5日前、未入荷）
  const p4 = await draft(supB, d(-5), [['TB-NT', 10, A]]);
  await place(p4.id, d(-12));
  // 下書き（PC-A）
  await draft(supC, d(10), [['PC-A', 20, B]]);

  // 場所移動：ステッカーねこ 10枚 棚B → イベントケース
  await inv.transfer(ctx, { idempotencyKey: k(), businessDate: d(-6), note: '週末イベント用', fromLocationId: B, toLocationId: E, reason: '', lines: [{ skuId: S['ST-CAT'], qty: 10 }], expected: [] });
  // イベントでの販売目的出庫
  const out = await inv.issue(ctx, {
    idempotencyKey: k(),
    businessDate: d(-5),
    note: '',
    purpose: 'sale',
    externalRef: 'EVENT-0001',
    destinationLabel: '週末クラフト市',
    lines: [
      { skuId: S['ST-CAT'], locationId: E, qty: 6 },
      { skuId: S['ST-LOGO'], locationId: B, qty: 2 },
    ],
    expected: [],
  });
  // 顧客返品（ステッカーロゴ1枚 → 検品保留）
  await inv.customerReturn(ctx, {
    idempotencyKey: k(),
    businessDate: d(-4),
    note: '',
    sourceEventId: out.result.lines[1].eventId,
    skuId: S['ST-LOGO'],
    locationId: H,
    qty: 1,
    reason: '折れがあるため返品',
    externalRef: '',
  });
  // 誤登録の取消（ノート3冊を誤って入庫 → 全量取消）
  const mis = await inv.outsideReceipt(ctx, {
    idempotencyKey: k(),
    businessDate: d(-4),
    note: '',
    reason: '知人からの持ち込み（誤入力）',
    externalRef: '',
    lines: [{ skuId: S['NB-A5'], locationId: B, qty: 3 }],
    expected: [],
  });
  await inv.reversal(ctx, { idempotencyKey: k(), businessDate: d(-4), note: '', eventId: mis.result.lines[0].eventId, qty: 3, reason: '入力ミス（実際には入庫なし）' });
  // 棚卸差異（イベントケース：ステッカーねこ 理論4、実数3、紛失）
  const s1 = await st.startStocktake(ctx, { idempotencyKey: k(), locationId: E, businessDate: d(-1) });
  const std = await st.getStocktake(ctx, s1.result.id);
  const line = std.lines.find((l) => l.skuId === S['ST-CAT'])!;
  const c1 = await st.recordCount(ctx, s1.result.id, { lineId: line.id, version: line.version, countedQty: 3 });
  await st.setReason(ctx, s1.result.id, { lineId: line.id, version: c1.version, reasonCode: 'loss', reasonNote: 'イベント中に紛失' });
  const rv = await st.toReview(ctx, s1.result.id, (await st.getStocktake(ctx, s1.result.id)).version);
  await st.confirmStocktake(ctx, s1.result.id, { idempotencyKey: k(), version: rv.version });
  // マグカップ黒：安全在庫割れ・補充対象、ポストカードB：在庫0・補充対象（初期在庫なし）
}
