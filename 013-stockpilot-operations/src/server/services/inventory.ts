// 在庫台帳エンジン（INVENTORY_RULES.md / API_CONTRACTS.md）
// すべての在庫変動はこのファイルの applyOperation を通る。画面・スマホ・CSV・棚卸・発注入荷で同じ検査を使う。
//
// ロック順序（デッドロック防止のため全経路で統一）:
//   tenants(FOR SHARE) → command_log → 元伝票 operations(ID順) → 発注明細 po_lines(ID順)
//   → locations(ID順) → balances(sku,location順) → workspaces（採番。常に最後）

import type { Tx } from '../db/pool.js';
import { fail } from '../errors.js';
import { MAX_BALANCE, MAX_LINES_PER_OP, isValidOpQty } from '../../shared/limits.js';
import { type Ctx, runCommand, uuid } from './context.js';
import type { z } from 'zod';
import type {
  zInitialStockCmd,
  zOutsideReceiptCmd,
  zIssueCmd,
  zTransferCmd,
  zDisposalCmd,
  zCorrectionCmd,
  zCustomerReturnCmd,
  zSupplierReturnCmd,
  zReversalCmd,
} from '../../shared/schemas.js';
import { isValidDate } from '../../shared/dates.js';

export type EventKind =
  | 'initial'
  | 'po_receipt'
  | 'outside_receipt'
  | 'issue_sale'
  | 'issue_other'
  | 'customer_return'
  | 'supplier_return'
  | 'transfer_out'
  | 'transfer_in'
  | 'disposal'
  | 'stocktake_adjust'
  | 'correction'
  | 'reversal';

export type OpKind =
  | 'initial'
  | 'po_receipt'
  | 'outside_receipt'
  | 'issue'
  | 'customer_return'
  | 'supplier_return'
  | 'transfer'
  | 'disposal'
  | 'stocktake_adjust'
  | 'correction'
  | 'reversal';

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  initial: '初期在庫',
  po_receipt: '発注入荷',
  outside_receipt: '発注外入庫',
  issue_sale: '販売目的出庫',
  issue_other: 'その他出庫',
  customer_return: '顧客返品入庫',
  supplier_return: '仕入先返品出庫',
  transfer_out: '場所移動（出）',
  transfer_in: '場所移動（入）',
  disposal: '破損・廃棄',
  stocktake_adjust: '棚卸調整',
  correction: '理由付き数量訂正',
  reversal: '誤登録の取消',
};

const INBOUND_DATE_KINDS = new Set<EventKind>(['initial', 'po_receipt', 'outside_receipt', 'customer_return']);
const OUTBOUND_DATE_KINDS = new Set<EventKind>(['issue_sale', 'issue_other']);

export interface Movement {
  skuId: string;
  locationId: string;
  delta: number; // 符号付き。サーバーが処理種別から決める
  kind: EventKind;
  poLineId?: string | null;
  sourceEventId?: string | null;
  reversalOfEventId?: string | null;
  pairLine?: number | null;
  reason?: string;
}

export interface OpSpec {
  kind: OpKind;
  purpose?: 'sale' | 'sample' | 'business_use' | 'other' | null;
  businessDate: string;
  reason?: string;
  note?: string;
  externalRef?: string;
  destinationLabel?: string;
  poId?: string | null;
  stocktakeId?: string | null;
  importId?: string | null;
  externalId?: string | null;
  externalHash?: string | null;
  noSource?: boolean;
  movements: Movement[];
  expected?: { skuId: string; locationId: string; qty: number }[];
  /** 棚卸確定時のみ：その棚卸による停止を通過させる */
  allowStocktakeId?: string;
  /** 取消・棚卸調整ではアーカイブ済みマスターも許可 */
  allowArchived?: boolean;
  /** ロック取得・残高読込の後、書込み前に呼ばれる追加検査 */
  check?: (c: Tx, state: LockedState) => Promise<void>;
}

export interface LockedState {
  skus: Map<string, SkuRow>;
  locations: Map<string, LocRow>;
  balances: Map<string, number>; // key = sku|loc
}

interface SkuRow {
  id: string;
  code: string;
  name: string;
  color: string;
  size: string;
  unit: string;
  archived: boolean;
}
interface LocRow {
  id: string;
  code: string;
  name: string;
  kind: 'normal' | 'hold';
  archived: boolean;
  stocktake_id: string | null;
}

export interface OpResultLine {
  lineNo: number;
  eventId: string;
  skuId: string;
  skuCode: string;
  skuName: string;
  unit: string;
  locationId: string;
  locationName: string;
  delta: number;
  before: number;
  after: number;
}

export interface OpResult {
  operationId: string;
  opNo: string;
  kind: OpKind;
  committedAt: string;
  businessDate: string;
  lines: OpResultLine[];
}

const bkey = (s: string, l: string) => `${s}|${l}`;

/** CSV取込など一括経路から渡す付帯情報 */
export interface ImportExtra {
  importId?: string;
  externalId?: string | null;
  externalHash?: string | null;
}

/** 事前にロケーションをID順でロックする（複数伝票をまとめて確定する経路用） */
export async function lockLocations(c: Tx, wsId: string, ids: string[]): Promise<Map<string, LocRow>> {
  const uniq = [...new Set(ids)].sort();
  const r = await c.query(
    `SELECT id, code, name, kind, archived, stocktake_id FROM locations WHERE ws_id=$1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
    [wsId, uniq],
  );
  if (r.rowCount !== uniq.length) fail('NOT_FOUND', '場所が見つかりません（削除済みまたは別アカウントの場所）');
  return new Map(r.rows.map((x) => [x.id, x as LocRow]));
}

export async function applyOperation(c: Tx, ctx: Ctx, spec: OpSpec): Promise<OpResult> {
  const mv = spec.movements;
  if (mv.length === 0) fail('VALIDATION', '明細がありません');
  if (mv.length > MAX_LINES_PER_OP * 2) fail('VALIDATION', `明細は${MAX_LINES_PER_OP}行までです`);
  if (!isValidDate(spec.businessDate)) fail('VALIDATION', '業務日付が不正です');
  for (const m of mv) {
    if (!Number.isSafeInteger(m.delta) || m.delta === 0 || Math.abs(m.delta) > MAX_BALANCE) fail('VALIDATION', '数量が不正です');
  }

  // SKU（存在・所属確認）
  const skuIds = [...new Set(mv.map((m) => m.skuId))];
  const sr = await c.query(`SELECT id, code, name, color, size, unit, archived FROM skus WHERE ws_id=$1 AND id = ANY($2::uuid[])`, [ctx.wsId, skuIds]);
  if (sr.rowCount !== skuIds.length) fail('NOT_FOUND', 'SKUが見つかりません（削除済みまたは別アカウントのSKU）');
  const skus = new Map(sr.rows.map((x) => [x.id, x as SkuRow]));

  // ロケーションをID順にロックし、棚卸停止を検査
  const locations = await lockLocations(
    c,
    ctx.wsId,
    mv.map((m) => m.locationId),
  );
  for (const l of locations.values()) {
    if (l.stocktake_id && l.stocktake_id !== spec.allowStocktakeId) {
      fail('LOCATION_LOCKED', `「${l.name}」は棚卸中のため入出庫・移動できません。棚卸の確定または中止後に操作してください。`, {
        locationId: l.id,
        stocktakeId: l.stocktake_id,
      });
    }
    if (l.archived && !spec.allowArchived) fail('STATE', `「${l.name}」はアーカイブ済みの場所です`);
  }
  if (!spec.allowArchived) {
    for (const s of skus.values()) if (s.archived) fail('STATE', `SKU「${s.code}」はアーカイブ済みです`);
  }

  // 残高行を確保（存在しない行は0で作成）してから sku,location 順にロック
  const pairs = [...new Map(mv.map((m) => [bkey(m.skuId, m.locationId), m])).values()]
    .map((m) => [m.skuId, m.locationId] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  await c.query(
    `INSERT INTO balances (ws_id, sku_id, location_id, qty) SELECT $1, s, l, 0 FROM unnest($2::uuid[], $3::uuid[]) AS t(s,l) ON CONFLICT DO NOTHING`,
    [ctx.wsId, pairs.map((p) => p[0]), pairs.map((p) => p[1])],
  );
  const br = await c.query(
    `SELECT b.sku_id, b.location_id, b.qty FROM balances b JOIN unnest($2::uuid[], $3::uuid[]) AS t(s,l) ON b.sku_id=t.s AND b.location_id=t.l
     WHERE b.ws_id=$1 ORDER BY b.sku_id, b.location_id FOR UPDATE OF b`,
    [ctx.wsId, pairs.map((p) => p[0]), pairs.map((p) => p[1])],
  );
  const balances = new Map<string, number>(br.rows.map((x) => [bkey(x.sku_id, x.location_id), Number(x.qty)]));

  // 古い画面の数量で確定しようとしていないか
  if (spec.expected?.length) {
    const stale = spec.expected
      .filter((e) => balances.has(bkey(e.skuId, e.locationId)) && balances.get(bkey(e.skuId, e.locationId)) !== e.qty)
      .map((e) => ({ ...e, current: balances.get(bkey(e.skuId, e.locationId)) }));
    if (stale.length) {
      fail('STALE_QTY', '表示していた数量から在庫が変わっています。最新の数量を確認してから確定してください。', { stale });
    }
  }

  const state: LockedState = { skus, locations, balances };
  if (spec.check) await spec.check(c, state);

  // 数量検証（負在庫・上限）
  const after = new Map(balances);
  for (const m of mv) after.set(bkey(m.skuId, m.locationId), (after.get(bkey(m.skuId, m.locationId)) ?? 0) + m.delta);
  const shortages = [];
  for (const [k, v] of after) {
    if (v < 0) {
      const [s, l] = k.split('|');
      shortages.push({ skuId: s, locationId: l, current: balances.get(k) ?? 0, required: (balances.get(k) ?? 0) - v });
    }
    if (v > MAX_BALANCE) fail('BALANCE_LIMIT', `残高の上限（${MAX_BALANCE.toLocaleString()}）を超えます`);
  }
  if (shortages.length) {
    const details = [];
    for (const sh of shortages) {
      const others = await c.query(
        `SELECT l.id, l.name, l.kind, b.qty FROM balances b JOIN locations l ON l.ws_id=b.ws_id AND l.id=b.location_id
         WHERE b.ws_id=$1 AND b.sku_id=$2 AND b.location_id<>$3 AND b.qty>0 ORDER BY l.code`,
        [ctx.wsId, sh.skuId, sh.locationId],
      );
      const sku = skus.get(sh.skuId)!;
      details.push({
        ...sh,
        skuCode: sku.code,
        skuName: sku.name,
        unit: sku.unit,
        locationName: locations.get(sh.locationId)!.name,
        otherLocations: others.rows.map((o) => ({ locationId: o.id, name: o.name, kind: o.kind, qty: Number(o.qty) })),
      });
    }
    const d = details[0];
    fail(
      'INSUFFICIENT_STOCK',
      `在庫が足りません：${d.skuCode} ${d.skuName}（${d.locationName}）現在${d.current}${d.unit}、必要${d.required}${d.unit}`,
      { shortages: details },
    );
  }

  // 採番（workspaces 行のロックは常に最後）
  const seq = await c.query(`UPDATE workspaces SET op_seq = op_seq + 1 WHERE id=$1 RETURNING op_seq`, [ctx.wsId]);
  const opNo = `IO-${String(seq.rows[0].op_seq).padStart(6, '0')}`;
  const opId = uuid();
  const now = ctx.now();
  await c.query(
    `INSERT INTO operations (ws_id,id,op_no,kind,purpose,business_date,committed_at,po_id,stocktake_id,import_id,reason,note,external_ref,destination_label,no_source,external_id,external_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      ctx.wsId,
      opId,
      opNo,
      spec.kind,
      spec.purpose ?? null,
      spec.businessDate,
      now,
      spec.poId ?? null,
      spec.stocktakeId ?? null,
      spec.importId ?? null,
      spec.reason ?? '',
      spec.note ?? '',
      spec.externalRef ?? '',
      spec.destinationLabel ?? '',
      spec.noSource ?? false,
      spec.externalId ?? null,
      spec.externalHash ?? null,
    ],
  );

  const running = new Map(balances);
  const lines: OpResultLine[] = [];
  const cols: unknown[][] = [[], [], [], [], [], [], [], [], [], [], [], [], [], []];
  mv.forEach((m, i) => {
    const k = bkey(m.skuId, m.locationId);
    const before = running.get(k) ?? 0;
    const a = before + m.delta;
    running.set(k, a);
    const sku = skus.get(m.skuId)!;
    const loc = locations.get(m.locationId)!;
    const eventId = uuid();
    const vals = [
      eventId,
      i + 1,
      m.kind,
      m.skuId,
      m.locationId,
      m.delta,
      m.poLineId ?? null,
      m.sourceEventId ?? null,
      m.reversalOfEventId ?? null,
      m.pairLine ?? null,
      m.reason ?? '',
      JSON.stringify({ code: sku.code, name: sku.name, color: sku.color, size: sku.size, unit: sku.unit }),
      JSON.stringify({ code: loc.code, name: loc.name, kind: loc.kind }),
      null,
    ];
    vals.forEach((v, j) => cols[j].push(v));
    lines.push({
      lineNo: i + 1,
      eventId,
      skuId: m.skuId,
      skuCode: sku.code,
      skuName: sku.name,
      unit: sku.unit,
      locationId: m.locationId,
      locationName: loc.name,
      delta: m.delta,
      before,
      after: a,
    });
  });
  await c.query(
    `INSERT INTO ledger_events (ws_id,id,op_id,line_no,kind,sku_id,location_id,qty,business_date,committed_at,actor_user_id,
       po_line_id,source_event_id,reversal_of_event_id,transfer_pair_line,reason,sku_snapshot,location_snapshot)
     SELECT $1, t.id, $2, t.line_no, t.kind, t.sku_id, t.location_id, t.qty, $3, $4, $5, t.po_line_id, t.source_event_id, t.reversal_of, t.pair, t.reason, t.sku_snap, t.loc_snap
     FROM unnest($6::uuid[], $7::int[], $8::text[], $9::uuid[], $10::uuid[], $11::int[], $12::uuid[], $13::uuid[], $14::uuid[], $15::int[], $16::text[], $17::jsonb[], $18::jsonb[])
       AS t(id, line_no, kind, sku_id, location_id, qty, po_line_id, source_event_id, reversal_of, pair, reason, sku_snap, loc_snap)`,
    [ctx.wsId, opId, spec.businessDate, now, ctx.userId, ...cols.slice(0, 13)],
  );

  // 残高と場所リビジョン（同じトランザクションで更新）
  const byPair = new Map<string, { s: string; l: string; d: number; inb: boolean; outb: boolean }>();
  for (const m of mv) {
    const k = bkey(m.skuId, m.locationId);
    const cur = byPair.get(k) ?? { s: m.skuId, l: m.locationId, d: 0, inb: false, outb: false };
    cur.d += m.delta;
    if (INBOUND_DATE_KINDS.has(m.kind) && m.delta > 0) cur.inb = true;
    if (OUTBOUND_DATE_KINDS.has(m.kind) && m.delta < 0) cur.outb = true;
    byPair.set(k, cur);
  }
  for (const p of byPair.values()) {
    await c.query(
      `UPDATE balances SET qty = qty + $4,
         last_in_date = CASE WHEN $5 THEN greatest(last_in_date, $6::date) ELSE last_in_date END,
         last_out_date = CASE WHEN $7 THEN greatest(last_out_date, $6::date) ELSE last_out_date END,
         updated_at = now()
       WHERE ws_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.wsId, p.s, p.l, p.d, p.inb, spec.businessDate, p.outb],
    );
  }
  const revCount = new Map<string, number>();
  for (const m of mv) revCount.set(m.locationId, (revCount.get(m.locationId) ?? 0) + 1);
  for (const [l, n] of revCount) await c.query(`UPDATE locations SET rev = rev + $3 WHERE ws_id=$1 AND id=$2`, [ctx.wsId, l, n]);

  return { operationId: opId, opNo, kind: spec.kind, committedAt: now.toISOString(), businessDate: spec.businessDate, lines };
}

function requireKind(state: LockedState, locationId: string, kind: 'normal' | 'hold', msg: string) {
  if (state.locations.get(locationId)!.kind !== kind) fail('VALIDATION', msg);
}

function noDupPairs(lines: { skuId: string; locationId: string }[]) {
  const seen = new Set<string>();
  for (const l of lines) {
    const k = bkey(l.skuId, l.locationId);
    if (seen.has(k)) fail('VALIDATION', '同じSKU・場所の明細が重複しています。1行にまとめてください。');
    seen.add(k);
  }
}

// ---------- 初期在庫 ----------
export async function initialStock(ctx: Ctx, cmd: z.infer<typeof zInitialStockCmd>) {
  noDupPairs(cmd.lines);
  return runCommand(ctx, 'initial_stock', cmd.idempotencyKey, cmd, (c) => initialStockTx(c, ctx, cmd));
}

export async function initialStockTx(c: Tx, ctx: Ctx, cmd: z.infer<typeof zInitialStockCmd>, extra: ImportExtra = {}) {
  return applyOperation(c, ctx, {
    kind: 'initial',
    businessDate: cmd.businessDate,
    note: cmd.note,
    ...extra,
    movements: cmd.lines.map((l) => ({ skuId: l.skuId, locationId: l.locationId, delta: l.qty, kind: 'initial' as const })),
    check: async (cc) => {
      const r = await cc.query(
        `SELECT DISTINCT e.sku_id, e.location_id, s.code, l.name FROM ledger_events e
           JOIN skus s ON s.ws_id=e.ws_id AND s.id=e.sku_id JOIN locations l ON l.ws_id=e.ws_id AND l.id=e.location_id
         JOIN unnest($2::uuid[], $3::uuid[]) AS t(s,l) ON e.sku_id=t.s AND e.location_id=t.l WHERE e.ws_id=$1`,
        [ctx.wsId, cmd.lines.map((l) => l.skuId), cmd.lines.map((l) => l.locationId)],
      );
      if (r.rowCount) {
        const x = r.rows[0];
        fail(
          'INITIAL_EXISTS',
          `「${x.code}」の「${x.name}」には既に履歴があるため初期在庫は登録できません。数量を合わせるには発注外入庫・理由付き訂正・棚卸を使ってください。`,
          { pairs: r.rows.map((y) => ({ skuId: y.sku_id, locationId: y.location_id })) },
        );
      }
    },
  });
}

// ---------- 発注外入庫 ----------
export async function outsideReceipt(ctx: Ctx, cmd: z.infer<typeof zOutsideReceiptCmd>) {
  noDupPairs(cmd.lines);
  return runCommand(ctx, 'outside_receipt', cmd.idempotencyKey, cmd, (c) => outsideReceiptTx(c, ctx, cmd));
}
export function outsideReceiptTx(c: Tx, ctx: Ctx, cmd: z.infer<typeof zOutsideReceiptCmd>, extra: ImportExtra = {}) {
  return applyOperation(c, ctx, {
    kind: 'outside_receipt',
    businessDate: cmd.businessDate,
    reason: cmd.reason,
    note: cmd.note,
    externalRef: cmd.externalRef,
    ...extra,
    expected: cmd.expected,
    movements: cmd.lines.map((l) => ({ skuId: l.skuId, locationId: l.locationId, delta: l.qty, kind: 'outside_receipt' as const, reason: cmd.reason })),
  });
}

// ---------- 出庫 ----------
export async function issue(ctx: Ctx, cmd: z.infer<typeof zIssueCmd>) {
  noDupPairs(cmd.lines);
  return runCommand(ctx, 'issue', cmd.idempotencyKey, cmd, (c) => issueTx(c, ctx, cmd));
}
export function issueTx(c: Tx, ctx: Ctx, cmd: z.infer<typeof zIssueCmd>, extra: ImportExtra = {}) {
  const kind: EventKind = cmd.purpose === 'sale' ? 'issue_sale' : 'issue_other';
  return applyOperation(c, ctx, {
    kind: 'issue',
    purpose: cmd.purpose,
    businessDate: cmd.businessDate,
    note: cmd.note,
    externalRef: cmd.externalRef,
    destinationLabel: cmd.destinationLabel,
    ...extra,
    expected: cmd.expected,
    movements: cmd.lines.map((l) => ({ skuId: l.skuId, locationId: l.locationId, delta: -l.qty, kind })),
    check: async (_c, st) => {
      for (const l of cmd.lines) {
        requireKind(
          st,
          l.locationId,
          'normal',
          `「${st.locations.get(l.locationId)!.name}」は保留場所のため出庫できません。通常場所への移動、廃棄、仕入先返品を使ってください。`,
        );
      }
    },
  });
}

// ---------- 場所移動 ----------
export async function transfer(ctx: Ctx, cmd: z.infer<typeof zTransferCmd>) {
  if (cmd.fromLocationId === cmd.toLocationId) fail('VALIDATION', '移動元と移動先が同じです');
  const seen = new Set<string>();
  for (const l of cmd.lines) {
    if (seen.has(l.skuId)) fail('VALIDATION', '同じSKUの明細が重複しています');
    seen.add(l.skuId);
  }
  return runCommand(ctx, 'transfer', cmd.idempotencyKey, cmd, (c) => transferTx(c, ctx, cmd));
}
export function transferTx(c: Tx, ctx: Ctx, cmd: z.infer<typeof zTransferCmd>, extra: ImportExtra = {}) {
  if (cmd.fromLocationId === cmd.toLocationId) fail('VALIDATION', '移動元と移動先が同じです');
  const movements: Movement[] = [];
  cmd.lines.forEach((l, i) => {
    movements.push({ skuId: l.skuId, locationId: cmd.fromLocationId, delta: -l.qty, kind: 'transfer_out', pairLine: 2 * i + 2, reason: cmd.reason });
    movements.push({ skuId: l.skuId, locationId: cmd.toLocationId, delta: l.qty, kind: 'transfer_in', pairLine: 2 * i + 1, reason: cmd.reason });
  });
  return applyOperation(c, ctx, {
    kind: 'transfer',
    businessDate: cmd.businessDate,
    reason: cmd.reason,
    note: cmd.note,
    ...extra,
    expected: cmd.expected,
    movements,
    check: async (_c, st) => {
      const from = st.locations.get(cmd.fromLocationId)!;
      const to = st.locations.get(cmd.toLocationId)!;
      if (from.kind === 'hold' && to.kind === 'normal' && !cmd.reason.trim()) {
        fail('VALIDATION', '保留から通常への移動（検品解除）には理由が必要です');
      }
    },
  });
}

// ---------- 破損・廃棄 ----------
export async function disposal(ctx: Ctx, cmd: z.infer<typeof zDisposalCmd>) {
  noDupPairs(cmd.lines);
  return runCommand(ctx, 'disposal', cmd.idempotencyKey, cmd, (c) =>
    applyOperation(c, ctx, {
      kind: 'disposal',
      businessDate: cmd.businessDate,
      reason: cmd.reason,
      note: cmd.note,
      expected: cmd.expected,
      movements: cmd.lines.map((l) => ({ skuId: l.skuId, locationId: l.locationId, delta: -l.qty, kind: 'disposal' as const, reason: cmd.reason })),
    }),
  );
}

// ---------- 理由付き数量訂正 ----------
export async function correction(ctx: Ctx, cmd: z.infer<typeof zCorrectionCmd>) {
  noDupPairs(cmd.lines);
  return runCommand(ctx, 'correction', cmd.idempotencyKey, cmd, (c) => correctionTx(c, ctx, cmd));
}
export function correctionTx(c: Tx, ctx: Ctx, cmd: z.infer<typeof zCorrectionCmd>, extra: ImportExtra = {}) {
  return applyOperation(c, ctx, {
    kind: 'correction',
    businessDate: cmd.businessDate,
    reason: cmd.reason,
    note: cmd.note,
    ...extra,
    expected: cmd.expected,
    movements: cmd.lines.map((l) => ({
      skuId: l.skuId,
      locationId: l.locationId,
      delta: l.direction === 'increase' ? l.qty : -l.qty,
      kind: 'correction' as const,
      reason: cmd.reason,
    })),
  });
}

// ---------- 取消可能数量の計算 ----------
interface SourceEvent {
  id: string;
  op_id: string;
  kind: EventKind;
  sku_id: string;
  location_id: string;
  qty: number;
  po_line_id: string | null;
  transfer_pair_line: number | null;
  line_no: number;
}

async function lockSourceEvent(c: Tx, wsId: string, eventId: string): Promise<SourceEvent> {
  const e = await c.query(
    `SELECT id, op_id, kind, sku_id, location_id, qty, po_line_id, transfer_pair_line, line_no FROM ledger_events WHERE ws_id=$1 AND id=$2`,
    [wsId, eventId],
  );
  if (e.rowCount === 0) fail('NOT_FOUND', '元の履歴が見つかりません');
  // 元伝票のヘッダーをロックし、同じ元に対する取消・返品を直列化する
  await c.query(`SELECT id FROM operations WHERE ws_id=$1 AND id=$2 FOR UPDATE`, [wsId, e.rows[0].op_id]);
  return e.rows[0] as SourceEvent;
}

/** 元イベントに対して、まだ取消・返品できる数量（|元数量| − 取消済み − 返品済み） */
export async function remainingOf(c: Tx, wsId: string, ev: SourceEvent): Promise<{ reversed: number; returned: number; remaining: number }> {
  const r = await c.query(
    `SELECT
       coalesce((SELECT sum(abs(qty)) FROM ledger_events WHERE ws_id=$1 AND reversal_of_event_id=$2),0)::bigint AS reversed,
       coalesce((SELECT sum(abs(x.qty)) - coalesce((SELECT sum(abs(y.qty)) FROM ledger_events y
                   WHERE y.ws_id=$1 AND y.reversal_of_event_id IN (SELECT id FROM ledger_events WHERE ws_id=$1 AND source_event_id=$2)),0)
                 FROM ledger_events x WHERE x.ws_id=$1 AND x.source_event_id=$2),0)::bigint AS returned`,
    [wsId, ev.id],
  );
  const reversed = Number(r.rows[0].reversed);
  const returned = Number(r.rows[0].returned);
  return { reversed, returned, remaining: Math.abs(ev.qty) - reversed - returned };
}

// ---------- 顧客返品 ----------
export async function customerReturn(ctx: Ctx, cmd: z.infer<typeof zCustomerReturnCmd>) {
  return runCommand(ctx, 'customer_return', cmd.idempotencyKey, cmd, async (c) => {
    let noSource = false;
    if (cmd.sourceEventId) {
      const src = await lockSourceEvent(c, ctx.wsId, cmd.sourceEventId);
      if (src.kind !== 'issue_sale' && src.kind !== 'issue_other') fail('VALIDATION', '返品の元は出庫の履歴を選んでください');
      if (src.sku_id !== cmd.skuId) fail('VALIDATION', '元の出庫とSKUが一致しません');
      const rem = await remainingOf(c, ctx.wsId, src);
      if (cmd.qty > rem.remaining) {
        fail('OVER_CAP', `返品数量が元の出庫数量を超えます（元${Math.abs(src.qty)}、返品済み${rem.returned}、取消済み${rem.reversed}、残り${rem.remaining}）`, rem);
      }
    } else {
      if (!cmd.reason.trim()) fail('VALIDATION', '元履歴なし返品には理由が必要です');
      noSource = true;
    }
    return applyOperation(c, ctx, {
      kind: 'customer_return',
      businessDate: cmd.businessDate,
      reason: cmd.reason,
      note: cmd.note,
      externalRef: cmd.externalRef,
      noSource,
      movements: [{ skuId: cmd.skuId, locationId: cmd.locationId, delta: cmd.qty, kind: 'customer_return', sourceEventId: cmd.sourceEventId, reason: cmd.reason }],
      check: async (_c, st) => requireKind(st, cmd.locationId, 'hold', '顧客返品はいったん保留場所へ入庫してください（検品後に通常場所へ移動します）'),
    });
  });
}

// ---------- 仕入先返品 ----------
export async function supplierReturn(ctx: Ctx, cmd: z.infer<typeof zSupplierReturnCmd>) {
  return runCommand(ctx, 'supplier_return', cmd.idempotencyKey, cmd, async (c) => {
    const src = await lockSourceEvent(c, ctx.wsId, cmd.sourceEventId);
    if (src.kind !== 'po_receipt' && src.kind !== 'outside_receipt') fail('VALIDATION', '仕入先返品の元は受領（入荷）の履歴を選んでください');
    const rem = await remainingOf(c, ctx.wsId, src);
    if (cmd.qty > rem.remaining) {
      fail('OVER_CAP', `返品数量が元の受領数量を超えます（元${src.qty}、返品済み${rem.returned}、取消済み${rem.reversed}、残り${rem.remaining}）`, rem);
    }
    const po = src.po_line_id
      ? (await c.query(`SELECT po_id FROM po_lines WHERE ws_id=$1 AND id=$2`, [ctx.wsId, src.po_line_id])).rows[0]?.po_id
      : null;
    // 仕入先返品は過去の入荷をなかったことにしない：発注の受領数 R と発注残は変更しない
    return applyOperation(c, ctx, {
      kind: 'supplier_return',
      businessDate: cmd.businessDate,
      reason: cmd.reason,
      note: cmd.note,
      externalRef: cmd.externalRef,
      poId: po,
      expected: cmd.expected,
      movements: [{ skuId: src.sku_id, locationId: cmd.locationId, delta: -cmd.qty, kind: 'supplier_return', sourceEventId: src.id, reason: cmd.reason }],
    });
  });
}

// ---------- 誤登録の取消（補償イベント） ----------
const NON_REVERSIBLE = new Set<EventKind>(['reversal', 'stocktake_adjust']);

export async function reversal(ctx: Ctx, cmd: z.infer<typeof zReversalCmd>) {
  if (!isValidOpQty(cmd.qty)) fail('VALIDATION', '数量が不正です');
  return runCommand(ctx, 'reversal', cmd.idempotencyKey, cmd, async (c) => {
    const src = await lockSourceEvent(c, ctx.wsId, cmd.eventId);
    if (NON_REVERSIBLE.has(src.kind)) {
      fail('VALIDATION', src.kind === 'reversal' ? '取消の履歴はさらに取り消せません。正しい操作を登録し直してください。' : '棚卸調整は取り消せません。再棚卸または理由付き訂正を使ってください。');
    }
    let events: SourceEvent[] = [src];
    if (src.kind === 'transfer_out' || src.kind === 'transfer_in') {
      const pair = await c.query(
        `SELECT id, op_id, kind, sku_id, location_id, qty, po_line_id, transfer_pair_line, line_no FROM ledger_events WHERE ws_id=$1 AND op_id=$2 AND line_no=$3`,
        [ctx.wsId, src.op_id, src.transfer_pair_line],
      );
      events = [src, pair.rows[0] as SourceEvent].sort((a, b) => a.line_no - b.line_no);
    }
    for (const ev of events) {
      const rem = await remainingOf(c, ctx.wsId, ev);
      if (cmd.qty > rem.remaining) {
        fail(
          'OVER_CAP',
          `取消数量が取り消せる数量を超えています（元${Math.abs(ev.qty)}、取消済み${rem.reversed}${rem.returned ? `、返品済み${rem.returned}` : ''}、残り${rem.remaining}）`,
          rem,
        );
      }
    }
    // 発注入荷の取消は受領数 R も同じトランザクションで戻す
    let poId: string | null = null;
    if (src.po_line_id) {
      const pl = await c.query(`SELECT po_id, received_qty FROM po_lines WHERE ws_id=$1 AND id=$2 FOR UPDATE`, [ctx.wsId, src.po_line_id]);
      poId = pl.rows[0].po_id;
      if (pl.rows[0].received_qty < cmd.qty) fail('OVER_CAP', '受領済み数量を超えて取り消せません');
    }
    const result = await applyOperation(c, ctx, {
      kind: 'reversal',
      businessDate: cmd.businessDate,
      reason: cmd.reason,
      note: cmd.note,
      poId,
      allowArchived: true,
      movements: events.map((ev) => ({
        skuId: ev.sku_id,
        locationId: ev.location_id,
        delta: ev.qty > 0 ? -cmd.qty : cmd.qty,
        kind: 'reversal' as const,
        reversalOfEventId: ev.id,
        poLineId: ev.po_line_id,
        reason: cmd.reason,
      })),
    });
    if (src.po_line_id) {
      await c.query(`UPDATE po_lines SET received_qty = received_qty - $3 WHERE ws_id=$1 AND id=$2`, [ctx.wsId, src.po_line_id, cmd.qty]);
    }
    return result;
  });
}
