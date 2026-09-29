// 参照系（一覧・詳細・履歴・ダッシュボード・コード解決）。全件ロードせずページングする。
import { fail } from '../errors.js';
import { type Ctx, readTx, today } from './context.js';
import { parseInternalQr } from '../../shared/codes.js';
import { codeKey } from '../../shared/codes.js';
import { EVENT_KIND_LABEL, type EventKind } from './inventory.js';
import { computeReplenishment } from '../../domain/replenish.js';
import { diffDays } from '../../shared/dates.js';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;

export interface InventoryFilter {
  q?: string;
  locationId?: string;
  supplierId?: string;
  category?: string;
  filter?: 'zero' | 'below_safety' | 'replenish' | 'on_order' | 'overdue' | 'hold' | 'stocktake' | 'archived';
  limit?: number;
  offset?: number;
}

export async function listInventory(ctx: Ctx, f: InventoryFilter) {
  const t = today(ctx);
  return readTx(ctx, async (c) => {
    const params: unknown[] = [ctx.wsId, t];
    const where = [f.filter === 'archived' ? 's.archived' : 'NOT s.archived'];
    if (f.q) {
      params.push(like(f.q));
      const p = `$${params.length}`;
      where.push(
        `(s.code ILIKE ${p} OR s.name ILIKE ${p} OR s.group_name ILIKE ${p} OR s.category ILIKE ${p} OR s.color ILIKE ${p} OR s.size ILIKE ${p}
          OR EXISTS (SELECT 1 FROM sku_codes k WHERE k.ws_id=s.ws_id AND k.sku_id=s.id AND k.code ILIKE ${p})
          OR EXISTS (SELECT 1 FROM suppliers sp WHERE sp.ws_id=s.ws_id AND sp.id=s.supplier_id AND sp.name ILIKE ${p})
          OR EXISTS (SELECT 1 FROM balances b JOIN locations l ON l.ws_id=b.ws_id AND l.id=b.location_id WHERE b.ws_id=s.ws_id AND b.sku_id=s.id AND b.qty>0 AND (l.name ILIKE ${p} OR l.code ILIKE ${p})))`,
      );
    }
    if (f.locationId) {
      params.push(f.locationId);
      where.push(`EXISTS (SELECT 1 FROM balances b WHERE b.ws_id=s.ws_id AND b.sku_id=s.id AND b.location_id=$${params.length} AND b.qty>0)`);
    }
    if (f.supplierId) {
      params.push(f.supplierId);
      where.push(`s.supplier_id=$${params.length}`);
    }
    if (f.category) {
      params.push(f.category);
      where.push(`s.category=$${params.length}`);
    }
    const base = `
      SELECT s.id, s.code, s.name, s.group_name, s.color, s.size, s.category, s.unit, s.photo_file_id, s.archived,
        s.safety_stock, s.reorder_point, s.target_stock, s.min_order_qty, s.order_multiple,
        coalesce(bn.qty,0)::bigint AS available, coalesce(bh.qty,0)::bigint AS hold,
        coalesce(po.o,0)::bigint AS on_order, coalesce(po.o_normal,0)::bigint AS on_order_normal, coalesce(po.overdue,0)::bigint AS overdue,
        bn.last_in, bn.last_out, coalesce(bl.locs,'[]') AS locs, coalesce(bl.locked,false) AS in_stocktake
      FROM skus s
      LEFT JOIN LATERAL (SELECT sum(b.qty) qty, max(b.last_in_date) last_in, max(b.last_out_date) last_out FROM balances b JOIN locations l ON l.ws_id=b.ws_id AND l.id=b.location_id
                         WHERE b.ws_id=s.ws_id AND b.sku_id=s.id AND l.kind='normal') bn ON true
      LEFT JOIN LATERAL (SELECT sum(b.qty) qty FROM balances b JOIN locations l ON l.ws_id=b.ws_id AND l.id=b.location_id
                         WHERE b.ws_id=s.ws_id AND b.sku_id=s.id AND l.kind='hold') bh ON true
      LEFT JOIN LATERAL (SELECT sum(pl.qty-pl.received_qty-pl.cancelled_qty) o,
                           sum(CASE WHEN l.kind='normal' THEN pl.qty-pl.received_qty-pl.cancelled_qty ELSE 0 END) o_normal,
                           sum(CASE WHEN coalesce(pl.due_date,p.due_date) < $2::date THEN pl.qty-pl.received_qty-pl.cancelled_qty ELSE 0 END) overdue
                         FROM po_lines pl JOIN purchase_orders p ON p.ws_id=pl.ws_id AND p.id=pl.po_id JOIN locations l ON l.ws_id=pl.ws_id AND l.id=pl.location_id
                         WHERE pl.ws_id=s.ws_id AND pl.sku_id=s.id AND p.status='placed' AND pl.qty-pl.received_qty-pl.cancelled_qty>0) po ON true
      LEFT JOIN LATERAL (SELECT json_agg(json_build_object('locationId',l.id,'name',l.name,'kind',l.kind,'qty',b.qty,'locked',l.stocktake_id IS NOT NULL) ORDER BY l.code) locs,
                           bool_or(l.stocktake_id IS NOT NULL) locked
                         FROM balances b JOIN locations l ON l.ws_id=b.ws_id AND l.id=b.location_id WHERE b.ws_id=s.ws_id AND b.sku_id=s.id AND b.qty>0) bl ON true
      WHERE s.ws_id=$1 AND ${where.join(' AND ')}`;
    let post = '';
    switch (f.filter) {
      case 'zero':
        post = 'WHERE x.available = 0';
        break;
      case 'below_safety':
        post = 'WHERE x.safety_stock IS NOT NULL AND x.available < x.safety_stock';
        break;
      case 'replenish':
        post = 'WHERE x.reorder_point IS NOT NULL AND x.available + x.on_order_normal <= x.reorder_point';
        break;
      case 'on_order':
        post = 'WHERE x.on_order > 0';
        break;
      case 'overdue':
        post = 'WHERE x.overdue > 0';
        break;
      case 'hold':
        post = 'WHERE x.hold > 0';
        break;
      case 'stocktake':
        post = 'WHERE x.in_stocktake';
        break;
    }
    const limit = Math.min(f.limit ?? 50, 200);
    params.push(limit + 1, f.offset ?? 0);
    const r = await c.query(`SELECT * FROM (${base}) x ${post} ORDER BY x.code LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const rows = r.rows.slice(0, limit).map((x) => {
      const settings =
        x.reorder_point === null
          ? null
          : { safetyStock: x.safety_stock, reorderPoint: x.reorder_point, targetStock: x.target_stock, minOrderQty: x.min_order_qty, orderMultiple: x.order_multiple };
      const rep = computeReplenishment({ available: Number(x.available), onOrder: Number(x.on_order_normal), settings });
      return {
        id: x.id,
        code: x.code,
        name: x.name,
        groupName: x.group_name,
        color: x.color,
        size: x.size,
        category: x.category,
        unit: x.unit,
        photoFileId: x.photo_file_id,
        archived: x.archived,
        available: Number(x.available),
        hold: Number(x.hold),
        onOrder: Number(x.on_order),
        overdue: Number(x.overdue),
        lastIn: x.last_in,
        lastOut: x.last_out,
        locations: x.locs,
        inStocktake: x.in_stocktake,
        configured: rep.configured,
        belowSafety: rep.belowSafety,
        recommended: rep.recommended,
      };
    });
    return { rows, hasMore: r.rows.length > limit };
  });
}

export async function getSku(ctx: Ctx, id: string) {
  return readTx(ctx, async (c) => {
    const r = await c.query(
      `SELECT s.*, sp.name supplier_name FROM skus s LEFT JOIN suppliers sp ON sp.ws_id=s.ws_id AND sp.id=s.supplier_id WHERE s.ws_id=$1 AND s.id=$2`,
      [ctx.wsId, id],
    );
    if (r.rowCount === 0) fail('NOT_FOUND', 'SKUが見つかりません');
    const s = r.rows[0];
    const codes = await c.query(`SELECT id, code, kind FROM sku_codes WHERE ws_id=$1 AND sku_id=$2 ORDER BY created_at`, [ctx.wsId, id]);
    const bal = await c.query(
      `SELECT l.id, l.code, l.name, l.kind, l.stocktake_id, coalesce(b.qty,0)::bigint qty, b.last_in_date, b.last_out_date
       FROM balances b JOIN locations l ON l.ws_id=b.ws_id AND l.id=b.location_id WHERE b.ws_id=$1 AND b.sku_id=$2 ORDER BY l.code`,
      [ctx.wsId, id],
    );
    const po = await c.query(
      `SELECT coalesce(sum(CASE WHEN l.kind='normal' THEN pl.qty-pl.received_qty-pl.cancelled_qty ELSE 0 END),0)::bigint o_normal,
              coalesce(sum(pl.qty-pl.received_qty-pl.cancelled_qty),0)::bigint o
       FROM po_lines pl JOIN purchase_orders p ON p.ws_id=pl.ws_id AND p.id=pl.po_id JOIN locations l ON l.ws_id=pl.ws_id AND l.id=pl.location_id
       WHERE pl.ws_id=$1 AND pl.sku_id=$2 AND p.status='placed'`,
      [ctx.wsId, id],
    );
    const available = bal.rows.filter((b) => b.kind === 'normal').reduce((a, b) => a + Number(b.qty), 0);
    const hold = bal.rows.filter((b) => b.kind === 'hold').reduce((a, b) => a + Number(b.qty), 0);
    const settings =
      s.reorder_point === null
        ? null
        : { safetyStock: s.safety_stock, reorderPoint: s.reorder_point, targetStock: s.target_stock, minOrderQty: s.min_order_qty, orderMultiple: s.order_multiple };
    const rep = computeReplenishment({ available, onOrder: Number(po.rows[0].o_normal), settings });
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      groupName: s.group_name,
      color: s.color,
      size: s.size,
      attrs: s.attrs,
      category: s.category,
      brand: s.brand,
      unit: s.unit,
      supplierId: s.supplier_id,
      supplierName: s.supplier_name,
      memo: s.memo,
      photoFileId: s.photo_file_id,
      archived: s.archived,
      replenish: settings,
      leadTimeDays: s.lead_time_days,
      version: s.version,
      codes: codes.rows,
      balances: bal.rows.map((b) => ({
        locationId: b.id,
        code: b.code,
        name: b.name,
        kind: b.kind,
        qty: Number(b.qty),
        inStocktake: !!b.stocktake_id,
        lastIn: b.last_in_date,
        lastOut: b.last_out_date,
      })),
      available,
      hold,
      onOrder: Number(po.rows[0].o),
      onOrderNormal: Number(po.rows[0].o_normal),
      replenishment: rep,
    };
  });
}

export interface HistoryFilter {
  skuId?: string;
  locationId?: string;
  opId?: string;
  kind?: string;
  from?: string;
  to?: string;
  limit?: number;
  beforeSeq?: number;
}

/** 台帳履歴（確定順＝seq 降順、カーソルページング） */
export async function listHistory(ctx: Ctx, f: HistoryFilter) {
  return readTx(ctx, async (c) => {
    const params: unknown[] = [ctx.wsId];
    const where = ['e.ws_id=$1'];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.skuId) add('e.sku_id=?', f.skuId);
    if (f.locationId) add('e.location_id=?', f.locationId);
    if (f.opId) add('e.op_id=?', f.opId);
    if (f.kind) add('e.kind=?', f.kind);
    if (f.from) add('e.business_date>=?', f.from);
    if (f.to) add('e.business_date<=?', f.to);
    if (f.beforeSeq) add('e.seq<?', f.beforeSeq);
    const limit = Math.min(f.limit ?? 50, 200);
    params.push(limit + 1);
    const r = await c.query(
      `SELECT e.id, e.seq, e.op_id, e.line_no, e.kind, e.sku_id, e.location_id, e.qty, e.business_date, e.committed_at, e.po_line_id, e.source_event_id,
         e.reversal_of_event_id, e.reason, e.sku_snapshot, e.location_snapshot, o.op_no, o.kind op_kind, o.purpose, o.po_id, o.stocktake_id, o.note,
         o.external_ref, o.destination_label, o.no_source, p.po_no, st.st_no,
         coalesce((SELECT sum(abs(x.qty)) FROM ledger_events x WHERE x.ws_id=e.ws_id AND x.reversal_of_event_id=e.id),0)::bigint reversed
       FROM ledger_events e JOIN operations o ON o.ws_id=e.ws_id AND o.id=e.op_id
       LEFT JOIN purchase_orders p ON p.ws_id=o.ws_id AND p.id=o.po_id LEFT JOIN stocktakes st ON st.ws_id=o.ws_id AND st.id=o.stocktake_id
       WHERE ${where.join(' AND ')} ORDER BY e.seq DESC LIMIT $${params.length}`,
      params,
    );
    const rows = r.rows.slice(0, limit).map((e) => ({
      id: e.id,
      seq: Number(e.seq),
      opId: e.op_id,
      opNo: e.op_no,
      opKind: e.op_kind,
      lineNo: e.line_no,
      kind: e.kind as EventKind,
      kindLabel: EVENT_KIND_LABEL[e.kind as EventKind],
      purpose: e.purpose,
      skuId: e.sku_id,
      locationId: e.location_id,
      qty: e.qty,
      businessDate: e.business_date,
      committedAt: e.committed_at,
      poId: e.po_id,
      poNo: e.po_no,
      stocktakeId: e.stocktake_id,
      stNo: e.st_no,
      poLineId: e.po_line_id,
      sourceEventId: e.source_event_id,
      reversalOfEventId: e.reversal_of_event_id,
      reason: e.reason,
      note: e.note,
      externalRef: e.external_ref,
      destinationLabel: e.destination_label,
      noSource: e.no_source,
      sku: e.sku_snapshot,
      location: e.location_snapshot,
      reversed: Number(e.reversed),
    }));
    return { rows, nextBeforeSeq: r.rows.length > limit ? rows[rows.length - 1].seq : null };
  });
}

export async function getOperation(ctx: Ctx, opId: string) {
  const r = await readTx(ctx, (c) =>
    c.query(
      `SELECT o.*, p.po_no, st.st_no FROM operations o LEFT JOIN purchase_orders p ON p.ws_id=o.ws_id AND p.id=o.po_id
       LEFT JOIN stocktakes st ON st.ws_id=o.ws_id AND st.id=o.stocktake_id WHERE o.ws_id=$1 AND o.id=$2`,
      [ctx.wsId, opId],
    ),
  );
  if (r.rowCount === 0) fail('NOT_FOUND', '伝票が見つかりません');
  const h = await listHistory(ctx, { opId, limit: 200 });
  const o = r.rows[0];
  return {
    id: o.id,
    opNo: o.op_no,
    kind: o.kind,
    purpose: o.purpose,
    businessDate: o.business_date,
    committedAt: o.committed_at,
    poId: o.po_id,
    poNo: o.po_no,
    stocktakeId: o.stocktake_id,
    stNo: o.st_no,
    reason: o.reason,
    note: o.note,
    externalRef: o.external_ref,
    destinationLabel: o.destination_label,
    noSource: o.no_source,
    lines: h.rows.sort((a, b) => a.lineNo - b.lineNo),
  };
}

/** スキャン・キーボード入力のコード解決。未登録コードでSKUを自動作成しない。 */
export async function resolveCode(ctx: Ctx, raw: string) {
  const text = raw.trim();
  if (!text) fail('VALIDATION', 'コードが空です');
  if (text.length > 200) fail('VALIDATION', 'コードが長すぎます');
  return readTx(ctx, async (c) => {
    const qr = parseInternalQr(text);
    if (qr) {
      // 内部QRのIDは、ログイン中のデータ内でのみ解決（他社のQRは見つからない）
      if (qr.type === 'SKU') {
        const r = await c.query(`SELECT id FROM skus WHERE ws_id=$1 AND id=$2`, [ctx.wsId, qr.id]);
        if (r.rowCount === 0) return { type: 'unknown' as const, text, message: 'このアカウントに登録されていない内部QRです' };
        return { type: 'sku' as const, skuId: r.rows[0].id as string, via: 'internal_qr' };
      }
      const r = await c.query(`SELECT id, name, kind FROM locations WHERE ws_id=$1 AND id=$2`, [ctx.wsId, qr.id]);
      if (r.rowCount === 0) return { type: 'unknown' as const, text, message: 'このアカウントに登録されていない場所QRです' };
      return { type: 'location' as const, locationId: r.rows[0].id as string, name: r.rows[0].name as string, kind: r.rows[0].kind as string };
    }
    const byCode = await c.query(`SELECT sku_id, kind FROM sku_codes WHERE ws_id=$1 AND code=$2`, [ctx.wsId, text]);
    if (byCode.rowCount) return { type: 'sku' as const, skuId: byCode.rows[0].sku_id as string, via: byCode.rows[0].kind as string };
    const bySku = await c.query(`SELECT id FROM skus WHERE ws_id=$1 AND code_key=$2`, [ctx.wsId, codeKey(text)]);
    if (bySku.rowCount) return { type: 'sku' as const, skuId: bySku.rows[0].id as string, via: 'sku_code' };
    const byLoc = await c.query(`SELECT id, name, kind FROM locations WHERE ws_id=$1 AND code_key=$2`, [ctx.wsId, codeKey(text)]);
    if (byLoc.rowCount) return { type: 'location' as const, locationId: byLoc.rows[0].id as string, name: byLoc.rows[0].name as string, kind: byLoc.rows[0].kind as string };
    return { type: 'unknown' as const, text, message: '登録されていないコードです。商品を自動では作成しません。' };
  });
}

export async function listLocations(ctx: Ctx, includeArchived = false) {
  return readTx(ctx, async (c) => {
    const r = await c.query(
      `SELECT l.id, l.code, l.name, l.description, l.kind, l.archived, l.stocktake_id, l.version,
         (SELECT count(*) FROM balances b WHERE b.ws_id=l.ws_id AND b.location_id=l.id AND b.qty>0)::int sku_count,
         st.st_no
       FROM locations l LEFT JOIN stocktakes st ON st.ws_id=l.ws_id AND st.id=l.stocktake_id
       WHERE l.ws_id=$1 ${includeArchived ? '' : 'AND NOT l.archived'} ORDER BY l.code`,
      [ctx.wsId],
    );
    return r.rows.map((l) => ({
      id: l.id,
      code: l.code,
      name: l.name,
      description: l.description,
      kind: l.kind,
      archived: l.archived,
      stocktakeId: l.stocktake_id,
      stNo: l.st_no,
      skuCount: l.sku_count,
      version: l.version,
    }));
  });
}

export async function locationStock(ctx: Ctx, locationId: string) {
  return readTx(ctx, async (c) => {
    const r = await c.query(
      `SELECT s.id, s.code, s.name, s.color, s.size, s.unit, s.photo_file_id, b.qty FROM balances b JOIN skus s ON s.ws_id=b.ws_id AND s.id=b.sku_id
       WHERE b.ws_id=$1 AND b.location_id=$2 AND b.qty>0 ORDER BY s.code`,
      [ctx.wsId, locationId],
    );
    return r.rows.map((x) => ({ skuId: x.id, code: x.code, name: x.name, color: x.color, size: x.size, unit: x.unit, photoFileId: x.photo_file_id, qty: Number(x.qty) }));
  });
}

export async function listSuppliers(ctx: Ctx, includeArchived = false) {
  return readTx(ctx, async (c) => {
    const r = await c.query(
      `SELECT id, code, name, contact_name, contact, lead_time_days, note, archived, version FROM suppliers WHERE ws_id=$1 ${includeArchived ? '' : 'AND NOT archived'} ORDER BY code`,
      [ctx.wsId],
    );
    return r.rows.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      contactName: s.contact_name,
      contact: s.contact,
      leadTimeDays: s.lead_time_days,
      note: s.note,
      archived: s.archived,
      version: s.version,
    }));
  });
}

export async function dashboard(ctx: Ctx) {
  const t = today(ctx);
  return readTx(ctx, async (c) => {
    const r = await c.query(
      `WITH s AS (
         SELECT s.id, s.safety_stock, s.reorder_point,
           coalesce((SELECT sum(b.qty) FROM balances b JOIN locations l ON l.ws_id=b.ws_id AND l.id=b.location_id WHERE b.ws_id=s.ws_id AND b.sku_id=s.id AND l.kind='normal'),0) u,
           coalesce((SELECT sum(b.qty) FROM balances b JOIN locations l ON l.ws_id=b.ws_id AND l.id=b.location_id WHERE b.ws_id=s.ws_id AND b.sku_id=s.id AND l.kind='hold'),0) h,
           coalesce((SELECT sum(pl.qty-pl.received_qty-pl.cancelled_qty) FROM po_lines pl JOIN purchase_orders p ON p.ws_id=pl.ws_id AND p.id=pl.po_id
             JOIN locations l ON l.ws_id=pl.ws_id AND l.id=pl.location_id WHERE pl.ws_id=s.ws_id AND pl.sku_id=s.id AND p.status='placed' AND l.kind='normal'),0) o
         FROM skus s WHERE s.ws_id=$1 AND NOT s.archived)
       SELECT count(*)::int active_skus,
         count(*) FILTER (WHERE u=0)::int zero_skus,
         count(*) FILTER (WHERE safety_stock IS NOT NULL AND u < safety_stock)::int below_safety,
         count(*) FILTER (WHERE reorder_point IS NOT NULL AND u+o <= reorder_point)::int replenish_candidates,
         count(*) FILTER (WHERE h>0)::int hold_skus
       FROM s`,
      [ctx.wsId],
    );
    const p = await c.query(
      `SELECT count(*)::int pending_lines,
         count(*) FILTER (WHERE coalesce(pl.due_date,p.due_date) < $2::date)::int overdue_lines
       FROM po_lines pl JOIN purchase_orders p ON p.ws_id=pl.ws_id AND p.id=pl.po_id
       WHERE pl.ws_id=$1 AND p.status='placed' AND pl.qty-pl.received_qty-pl.cancelled_qty>0`,
      [ctx.wsId, t],
    );
    const st = await c.query(`SELECT count(*)::int n FROM stocktakes WHERE ws_id=$1 AND status IN ('counting','review')`, [ctx.wsId]);
    const drafts = await c.query(`SELECT count(*)::int n FROM purchase_orders WHERE ws_id=$1 AND status='draft'`, [ctx.wsId]);
    // 直近出庫なし：通常在庫があり、最終出庫日から90日以上（または出庫記録なし）のSKU数。在庫年齢は断定しない。
    const idle = await c.query(
      `SELECT count(*)::int n FROM (
         SELECT b.sku_id, max(b.last_out_date) lo, sum(b.qty) q FROM balances b JOIN locations l ON l.ws_id=b.ws_id AND l.id=b.location_id
         JOIN skus s ON s.ws_id=b.ws_id AND s.id=b.sku_id
         WHERE b.ws_id=$1 AND l.kind='normal' AND NOT s.archived GROUP BY b.sku_id) x
       WHERE x.q > 0 AND (x.lo IS NULL OR x.lo < ($2::date - 90))`,
      [ctx.wsId, t],
    );
    return {
      ...r.rows[0],
      ...p.rows[0],
      active_stocktakes: st.rows[0].n,
      draft_pos: drafts.rows[0].n,
      idle_90d: idle.rows[0].n,
      asOf: ctx.now().toISOString(),
      today: t,
    };
  });
}

export async function idleSkus(ctx: Ctx, days = 90) {
  const t = today(ctx);
  return readTx(ctx, async (c) => {
    const r = await c.query(
      `SELECT s.id, s.code, s.name, s.unit, sum(b.qty)::bigint q, max(b.last_out_date) last_out, max(b.last_in_date) last_in
       FROM balances b JOIN locations l ON l.ws_id=b.ws_id AND l.id=b.location_id JOIN skus s ON s.ws_id=b.ws_id AND s.id=b.sku_id
       WHERE b.ws_id=$1 AND l.kind='normal' AND NOT s.archived GROUP BY s.id HAVING sum(b.qty)>0 AND (max(b.last_out_date) IS NULL OR max(b.last_out_date) < ($2::date - $3::int))
       ORDER BY max(b.last_out_date) NULLS FIRST LIMIT 200`,
      [ctx.wsId, t, days],
    );
    return r.rows.map((x) => ({
      skuId: x.id,
      code: x.code,
      name: x.name,
      unit: x.unit,
      qty: Number(x.q),
      lastOut: x.last_out,
      lastIn: x.last_in,
      daysSinceOut: x.last_out ? diffDays(t, x.last_out) : null,
    }));
  });
}

/** 台帳から残高を再計算して残高テーブルと照合する（整合性検査） */
export async function verifyLedger(ctx: Ctx) {
  return readTx(ctx, async (c) => {
    const r = await c.query(
      `WITH led AS (SELECT sku_id, location_id, sum(qty)::bigint q FROM ledger_events WHERE ws_id=$1 GROUP BY sku_id, location_id)
       SELECT coalesce(b.sku_id, led.sku_id) sku_id, coalesce(b.location_id, led.location_id) location_id, coalesce(b.qty,0)::bigint balance, coalesce(led.q,0)::bigint ledger
       FROM (SELECT * FROM balances WHERE ws_id=$1) b FULL OUTER JOIN led ON led.sku_id=b.sku_id AND led.location_id=b.location_id
       WHERE coalesce(b.qty,0) <> coalesce(led.q,0)`,
      [ctx.wsId],
    );
    const po = await c.query(
      `SELECT pl.id, pl.received_qty, coalesce((SELECT sum(qty) FROM ledger_events e WHERE e.ws_id=pl.ws_id AND e.po_line_id=pl.id),0)::bigint ledger_r
       FROM po_lines pl WHERE pl.ws_id=$1 AND pl.received_qty <> coalesce((SELECT sum(qty) FROM ledger_events e WHERE e.ws_id=pl.ws_id AND e.po_line_id=pl.id),0)`,
      [ctx.wsId],
    );
    return { ok: r.rowCount === 0 && po.rowCount === 0, balanceMismatches: r.rows, poMismatches: po.rows };
  });
}
