// 帳票スナップショット。発行時点の許可項目だけを保存し、後のマスター変更で既存版を変えない。
// PDF生成は在庫確定とは別処理：生成に失敗しても在庫・発注は変わらず、同じスナップショットから再生成できる。
import { fail } from '../errors.js';
import { type Ctx, readTx, writeTx, uuid } from './context.js';
import { renderPoSheet, renderStocktakeDiff, renderLabels, type PoSheetSnapshot, type StocktakeSnapshot, type LabelItem } from '../pdf/render.js';
import { internalQrPayload } from '../../shared/codes.js';
import { getPo } from './po.js';

const variant = (color: string, size: string) => [color, size].filter(Boolean).join(' / ');

export async function issuePoSheet(ctx: Ctx, poId: string) {
  const p = await getPo(ctx, poId);
  return writeTx(ctx, async (c) => {
    const t = await c.query(`SELECT name FROM tenants WHERE id=$1`, [ctx.tenantId]);
    const sup = await c.query(`SELECT code, name, contact_name FROM suppliers WHERE ws_id=$1 AND id=$2`, [ctx.wsId, p.supplierId]);
    // 許可項目のみ（internalMemo・連絡先の詳細・内部IDは含めない）
    const snap: PoSheetSnapshot = {
      poNo: p.poNo,
      statusLabel: p.displayStatusLabel,
      issuedAt: ctx.now().toISOString(),
      orderedDate: p.orderedDate,
      dueDate: p.dueDate,
      business: { name: t.rows[0].name },
      supplier: { code: sup.rows[0].code, name: sup.rows[0].name, contactName: sup.rows[0].contact_name },
      deliveryLocation: p.locationName,
      externalRef: p.externalRef,
      supplierNote: p.supplierNote,
      lines: p.lines.map((l) => ({
        lineNo: l.lineNo,
        code: l.snapshot.code,
        name: l.snapshot.name,
        variant: variant(l.snapshot.color, l.snapshot.size),
        qty: l.qty,
        unit: l.snapshot.unit,
        dueDate: l.dueDate,
        location: l.locationName,
      })),
    };
    const id = uuid();
    await c.query(`INSERT INTO documents (ws_id,id,kind,ref_id,snapshot) VALUES ($1,$2,'po_sheet',$3,$4)`, [ctx.wsId, id, poId, JSON.stringify(snap)]);
    return { documentId: id };
  });
}

export async function issueLabels(ctx: Ctx, input: { skuIds: string[]; locationIds: string[]; copies: number }) {
  const copies = Math.max(1, Math.min(24, Math.floor(input.copies || 1)));
  if (input.skuIds.length + input.locationIds.length === 0) fail('VALIDATION', 'ラベルにするSKUまたは場所を選んでください');
  if ((input.skuIds.length + input.locationIds.length) * copies > 480) fail('VALIDATION', '1回に作れるラベルは480枚（20ページ）までです');
  return writeTx(ctx, async (c) => {
    const skus = input.skuIds.length
      ? (await c.query(`SELECT id, code, name, color, size FROM skus WHERE ws_id=$1 AND id = ANY($2::uuid[]) ORDER BY code`, [ctx.wsId, input.skuIds])).rows
      : [];
    const locs = input.locationIds.length
      ? (await c.query(`SELECT id, code, name, kind FROM locations WHERE ws_id=$1 AND id = ANY($2::uuid[]) ORDER BY code`, [ctx.wsId, input.locationIds])).rows
      : [];
    if (skus.length !== new Set(input.skuIds).size || locs.length !== new Set(input.locationIds).size) fail('NOT_FOUND', '対象が見つかりません');
    const jan = input.skuIds.length
      ? (await c.query(`SELECT sku_id, code FROM sku_codes WHERE ws_id=$1 AND sku_id = ANY($2::uuid[]) AND kind IN ('JAN13','EAN8') ORDER BY created_at`, [ctx.wsId, input.skuIds]))
          .rows
      : [];
    const items: LabelItem[] = [];
    for (const s of skus) {
      const j = jan.find((x) => x.sku_id === s.id);
      for (let i = 0; i < copies; i++) {
        items.push({
          payload: internalQrPayload('SKU', s.id),
          title: s.code,
          subtitle: [s.name, variant(s.color, s.size)].filter(Boolean).join('\n'),
          note: j ? `JAN ${j.code}（内部QRとは別）` : '内部QR',
        });
      }
    }
    for (const l of locs) {
      for (let i = 0; i < copies; i++) {
        items.push({ payload: internalQrPayload('LOC', l.id), title: l.name, subtitle: `場所 ${l.code}（${l.kind === 'hold' ? '保留' : '通常'}）`, note: '場所QR' });
      }
    }
    const id = uuid();
    await c.query(`INSERT INTO documents (ws_id,id,kind,ref_id,snapshot) VALUES ($1,$2,'labels',NULL,$3)`, [ctx.wsId, id, JSON.stringify({ items })]);
    return { documentId: id, count: items.length };
  });
}

export async function renderDocument(ctx: Ctx, documentId: string): Promise<{ pdf: Buffer; filename: string }> {
  const r = await readTx(ctx, (c) => c.query(`SELECT kind, snapshot FROM documents WHERE ws_id=$1 AND id=$2`, [ctx.wsId, documentId]));
  if (r.rowCount === 0) fail('NOT_FOUND', '帳票が見つかりません');
  const { kind, snapshot } = r.rows[0];
  if (kind === 'po_sheet') return { pdf: await renderPoSheet(snapshot as PoSheetSnapshot), filename: `${(snapshot as PoSheetSnapshot).poNo}_数量発注書.pdf` };
  if (kind === 'stocktake_diff') return { pdf: await renderStocktakeDiff(snapshot as StocktakeSnapshot), filename: `${(snapshot as StocktakeSnapshot).stNo}_棚卸差異.pdf` };
  return { pdf: await renderLabels((snapshot as { items: LabelItem[] }).items), filename: 'QRラベル.pdf' };
}
