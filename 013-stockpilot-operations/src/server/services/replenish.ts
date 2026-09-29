// 補充候補（INVENTORY_RULES.md §補充）。推奨は補助であり、自動発注はしない。
import { z } from 'zod';
import { fail } from '../errors.js';
import { type Ctx, readTx, runCommand, today } from './context.js';
import { computeReplenishment } from '../../domain/replenish.js';
import { createDraftTx, currentBasis } from './po.js';
import { addDays } from '../../shared/dates.js';
import { zIdemKey, zOpQty, zUuid, zDate } from '../../shared/schemas.js';

export interface CandidateRow {
  skuId: string;
  skuCode: string;
  skuName: string;
  color: string;
  size: string;
  unit: string;
  photoFileId: string | null;
  supplierId: string | null;
  supplierName: string | null;
  available: number;
  hold: number;
  onOrder: number;
  overdueOnOrder: number;
  draftQty: number;
  draftPoNos: string[];
  p: number;
  configured: boolean;
  safetyStock: number | null;
  reorderPoint: number | null;
  targetStock: number | null;
  minOrderQty: number | null;
  orderMultiple: number | null;
  leadTimeDays: number | null;
  recommended: number;
  need: number;
  belowSafety: boolean;
  atOrBelowReorder: boolean;
  reason: string;
  locations: { locationId: string; name: string; kind: string; qty: number }[];
  suggestedDueDate: string | null;
}

export async function loadReplenishRows(ctx: Ctx, opts: { skuIds?: string[] } = {}): Promise<CandidateRow[]> {
  const t = today(ctx);
  return readTx(ctx, async (c) => {
    const params: unknown[] = [ctx.wsId, t];
    let filter = '';
    if (opts.skuIds) {
      params.push(opts.skuIds);
      filter = `AND s.id = ANY($3::uuid[])`;
    }
    const r = await c.query(
      `SELECT s.id, s.code, s.name, s.color, s.size, s.unit, s.photo_file_id, s.supplier_id, sp.name supplier_name,
         s.safety_stock, s.reorder_point, s.target_stock, s.min_order_qty, s.order_multiple, coalesce(s.lead_time_days, sp.lead_time_days) lead_time_days,
         coalesce((SELECT sum(b.qty) FROM balances b JOIN locations l ON l.ws_id=b.ws_id AND l.id=b.location_id WHERE b.ws_id=s.ws_id AND b.sku_id=s.id AND l.kind='normal'),0)::bigint u,
         coalesce((SELECT sum(b.qty) FROM balances b JOIN locations l ON l.ws_id=b.ws_id AND l.id=b.location_id WHERE b.ws_id=s.ws_id AND b.sku_id=s.id AND l.kind='hold'),0)::bigint hold,
         coalesce((SELECT sum(pl.qty-pl.received_qty-pl.cancelled_qty) FROM po_lines pl JOIN purchase_orders p ON p.ws_id=pl.ws_id AND p.id=pl.po_id
                   JOIN locations l ON l.ws_id=pl.ws_id AND l.id=pl.location_id
                   WHERE pl.ws_id=s.ws_id AND pl.sku_id=s.id AND p.status='placed' AND l.kind='normal'),0)::bigint o,
         coalesce((SELECT sum(pl.qty-pl.received_qty-pl.cancelled_qty) FROM po_lines pl JOIN purchase_orders p ON p.ws_id=pl.ws_id AND p.id=pl.po_id
                   WHERE pl.ws_id=s.ws_id AND pl.sku_id=s.id AND p.status='placed' AND coalesce(pl.due_date,p.due_date) < $2::date),0)::bigint overdue_o,
         coalesce((SELECT sum(pl.qty) FROM po_lines pl JOIN purchase_orders p ON p.ws_id=pl.ws_id AND p.id=pl.po_id
                   WHERE pl.ws_id=s.ws_id AND pl.sku_id=s.id AND p.status='draft'),0)::bigint draft_qty,
         coalesce((SELECT array_agg(DISTINCT p.po_no) FROM po_lines pl JOIN purchase_orders p ON p.ws_id=pl.ws_id AND p.id=pl.po_id
                   WHERE pl.ws_id=s.ws_id AND pl.sku_id=s.id AND p.status='draft'), '{}') draft_nos,
         coalesce((SELECT json_agg(json_build_object('locationId',l.id,'name',l.name,'kind',l.kind,'qty',b.qty) ORDER BY l.code)
                   FROM balances b JOIN locations l ON l.ws_id=b.ws_id AND l.id=b.location_id WHERE b.ws_id=s.ws_id AND b.sku_id=s.id AND b.qty>0),'[]') locs
       FROM skus s LEFT JOIN suppliers sp ON sp.ws_id=s.ws_id AND sp.id=s.supplier_id
       WHERE s.ws_id=$1 AND NOT s.archived ${filter}
       ORDER BY s.code`,
      params,
    );
    return r.rows.map((x) => {
      const settings =
        x.reorder_point === null
          ? null
          : {
              safetyStock: x.safety_stock,
              reorderPoint: x.reorder_point,
              targetStock: x.target_stock,
              minOrderQty: x.min_order_qty,
              orderMultiple: x.order_multiple,
            };
      const rep = computeReplenishment({ available: Number(x.u), onOrder: Number(x.o), settings });
      return {
        skuId: x.id,
        skuCode: x.code,
        skuName: x.name,
        color: x.color,
        size: x.size,
        unit: x.unit,
        photoFileId: x.photo_file_id,
        supplierId: x.supplier_id,
        supplierName: x.supplier_name,
        available: Number(x.u),
        hold: Number(x.hold),
        onOrder: Number(x.o),
        overdueOnOrder: Number(x.overdue_o),
        draftQty: Number(x.draft_qty),
        draftPoNos: x.draft_nos,
        p: rep.p,
        configured: rep.configured,
        safetyStock: x.safety_stock,
        reorderPoint: x.reorder_point,
        targetStock: x.target_stock,
        minOrderQty: x.min_order_qty,
        orderMultiple: x.order_multiple,
        leadTimeDays: x.lead_time_days,
        recommended: rep.recommended,
        need: rep.need,
        belowSafety: rep.belowSafety,
        atOrBelowReorder: rep.atOrBelowReorder,
        reason: rep.reason,
        locations: x.locs,
        suggestedDueDate: x.lead_time_days === null ? null : addDays(t, x.lead_time_days),
      };
    });
  });
}

export async function listCandidates(ctx: Ctx, filter: 'candidates' | 'all' | 'unconfigured' = 'candidates') {
  const rows = await loadReplenishRows(ctx);
  if (filter === 'all') return rows;
  if (filter === 'unconfigured') return rows.filter((r) => !r.configured);
  return rows.filter((r) => r.recommended > 0 || r.belowSafety || r.overdueOnOrder > 0);
}

export const zCreateDraftsCmd = z.object({
  idempotencyKey: zIdemKey,
  items: z
    .array(
      z.object({
        skuId: zUuid,
        supplierId: zUuid,
        qty: zOpQty,
        locationId: zUuid,
        dueDate: zDate.nullable().default(null),
        basisP: z.number().int(), // 画面で見ていた補充判断数量
      }),
    )
    .min(1)
    .max(200),
});

/** 選択した候補から仕入先別に発注下書きを作る。二重タップは冪等キーで1回だけ作る。 */
export async function createDraftsFromCandidates(ctx: Ctx, cmd: z.infer<typeof zCreateDraftsCmd>) {
  const seen = new Set<string>();
  for (const i of cmd.items) {
    if (seen.has(i.skuId)) fail('VALIDATION', '同じSKUが重複しています');
    seen.add(i.skuId);
  }
  return runCommand(ctx, 'replenish_drafts', cmd.idempotencyKey, cmd, async (c) => {
    // 画面表示後に在庫・発注残が変わっていないか確認
    const cur = await currentBasis(
      c,
      ctx.wsId,
      cmd.items.map((i) => i.skuId),
    );
    const changed = cmd.items.filter((i) => cur.get(i.skuId)?.p !== i.basisP).map((i) => ({ skuId: i.skuId, shown: i.basisP, current: cur.get(i.skuId)?.p }));
    if (changed.length) {
      fail('BASIS_CHANGED', '候補を表示した後に在庫または発注残が変わりました。候補を再読み込みして数量を確認してください。', { changed });
    }
    const bySupplier = new Map<string, typeof cmd.items>();
    for (const i of cmd.items) bySupplier.set(i.supplierId, [...(bySupplier.get(i.supplierId) ?? []), i]);
    const created = [];
    for (const [supplierId, items] of [...bySupplier.entries()].sort()) {
      const d = await createDraftTx(
        c,
        ctx,
        {
          supplierId,
          dueDate: null,
          locationId: null,
          externalRef: '',
          supplierNote: '',
          internalMemo: '',
          replacesPoId: null,
          lines: items.map((i) => ({ skuId: i.skuId, qty: i.qty, dueDate: i.dueDate, locationId: i.locationId, basisP: i.basisP })),
        },
        cmd.idempotencyKey,
      );
      created.push({ supplierId, poId: d.id, poNo: d.poNo, lines: items.length });
    }
    return { created };
  });
}
