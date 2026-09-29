// 発注・分納入荷・残数打切り（INVENTORY_RULES.md §発注）
import type { z } from 'zod';
import type { Tx } from '../db/pool.js';
import { fail } from '../errors.js';
import { type Ctx, runCommand, uuid, writeTx, readTx, today } from './context.js';
import { applyOperation, type Movement, type ImportExtra } from './inventory.js';
import type { PoDraftInput, zPoPlaceCmd, zPoReviseCmd, zPoCancelRemainingCmd, zReceiptCmd } from '../../shared/schemas.js';
import { poDisplayStatus, outstanding, PO_STATUS_LABEL } from '../../domain/po.js';
import { computeReplenishment } from '../../domain/replenish.js';

async function nextPoNo(c: Tx, wsId: string) {
  const r = await c.query(`UPDATE workspaces SET po_seq = po_seq + 1 WHERE id=$1 RETURNING po_seq`, [wsId]);
  return `PO-${String(r.rows[0].po_seq).padStart(5, '0')}`;
}

async function skuSnapshots(c: Tx, wsId: string, skuIds: string[]) {
  const r = await c.query(`SELECT id, code, name, color, size, unit, archived FROM skus WHERE ws_id=$1 AND id = ANY($2::uuid[])`, [wsId, [...new Set(skuIds)]]);
  const m = new Map(r.rows.map((x) => [x.id as string, x]));
  for (const id of skuIds) {
    if (!m.has(id)) fail('NOT_FOUND', 'SKUが見つかりません');
    if (m.get(id).archived) fail('STATE', `SKU「${m.get(id).code}」はアーカイブ済みです`);
  }
  return m;
}

async function checkLocations(c: Tx, wsId: string, ids: string[]) {
  const u = [...new Set(ids)];
  const r = await c.query(`SELECT id, archived FROM locations WHERE ws_id=$1 AND id = ANY($2::uuid[])`, [wsId, u]);
  if (r.rowCount !== u.length) fail('NOT_FOUND', '納入場所が見つかりません');
  if (r.rows.some((x) => x.archived)) fail('STATE', 'アーカイブ済みの場所は納入場所にできません');
}

async function snapshotPo(c: Tx, wsId: string, poId: string) {
  const p = await c.query(`SELECT * FROM purchase_orders WHERE ws_id=$1 AND id=$2`, [wsId, poId]);
  const l = await c.query(`SELECT * FROM po_lines WHERE ws_id=$1 AND po_id=$2 ORDER BY line_no`, [wsId, poId]);
  return { po: p.rows[0], lines: l.rows };
}

async function recordRevision(c: Tx, wsId: string, poId: string, action: string, reason: string) {
  const snap = await snapshotPo(c, wsId, poId);
  await c.query(`INSERT INTO po_revisions (ws_id,id,po_id,version,action,reason,snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    wsId,
    uuid(),
    poId,
    snap.po.version,
    action,
    reason,
    JSON.stringify(snap),
  ]);
}

// ---------- 下書き ----------
export async function createDraft(ctx: Ctx, input: PoDraftInput, sourceKey?: string) {
  return writeTx(ctx, (c) => createDraftTx(c, ctx, input, sourceKey));
}

export async function createDraftTx(c: Tx, ctx: Ctx, input: PoDraftInput, sourceKey?: string) {
  const sup = await c.query(`SELECT archived FROM suppliers WHERE ws_id=$1 AND id=$2`, [ctx.wsId, input.supplierId]);
  if (sup.rowCount === 0) fail('NOT_FOUND', '仕入先が見つかりません');
  if (sup.rows[0].archived) fail('STATE', 'アーカイブ済みの仕入先です');
  if (input.replacesPoId) {
    const rp = await c.query(`SELECT 1 FROM purchase_orders WHERE ws_id=$1 AND id=$2`, [ctx.wsId, input.replacesPoId]);
    if (rp.rowCount === 0) fail('NOT_FOUND', '交換元の発注が見つかりません');
  }
  const snaps = await skuSnapshots(
    c,
    ctx.wsId,
    input.lines.map((l) => l.skuId),
  );
  const locIds = input.lines.map((l) => l.locationId).concat(input.locationId ? [input.locationId] : []);
  if (locIds.length) await checkLocations(c, ctx.wsId, locIds);
  const id = uuid();
  const poNo = await nextPoNo(c, ctx.wsId);
  await c.query(
    `INSERT INTO purchase_orders (ws_id,id,po_no,supplier_id,status,created_date,due_date,location_id,external_ref,supplier_note,internal_memo,replaces_po_id,source_key)
     VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12)`,
    [ctx.wsId, id, poNo, input.supplierId, today(ctx), input.dueDate, input.locationId, input.externalRef, input.supplierNote, input.internalMemo, input.replacesPoId, sourceKey ?? null],
  );
  await insertLines(c, ctx.wsId, id, input.lines, snaps, 1);
  return { id, poNo, version: 1 };
}

async function insertLines(c: Tx, wsId: string, poId: string, lines: PoDraftInput['lines'], snaps: Map<string, any>, startNo: number) {
  let n = startNo;
  for (const l of lines) {
    const s = snaps.get(l.skuId);
    await c.query(
      `INSERT INTO po_lines (ws_id,id,po_id,line_no,sku_id,qty,due_date,location_id,basis_p,sku_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [wsId, l.id ?? uuid(), poId, n++, l.skuId, l.qty, l.dueDate, l.locationId, l.basisP ?? null, JSON.stringify({ code: s.code, name: s.name, color: s.color, size: s.size, unit: s.unit })],
    );
  }
}

export async function updateDraft(ctx: Ctx, poId: string, version: number, input: PoDraftInput) {
  return writeTx(ctx, async (c) => {
    const p = await c.query(`SELECT status, version FROM purchase_orders WHERE ws_id=$1 AND id=$2 FOR UPDATE`, [ctx.wsId, poId]);
    if (p.rowCount === 0) fail('NOT_FOUND', '発注が見つかりません');
    if (p.rows[0].status !== 'draft') fail('STATE', '発注済みの発注は「訂正」から理由を付けて変更してください');
    if (p.rows[0].version !== version) fail('VERSION_CONFLICT', '他の端末で更新されています。最新の内容を確認してください。');
    const snaps = await skuSnapshots(
      c,
      ctx.wsId,
      input.lines.map((l) => l.skuId),
    );
    const locIds = input.lines.map((l) => l.locationId).concat(input.locationId ? [input.locationId] : []);
    if (locIds.length) await checkLocations(c, ctx.wsId, locIds);
    const sup = await c.query(`SELECT 1 FROM suppliers WHERE ws_id=$1 AND id=$2`, [ctx.wsId, input.supplierId]);
    if (sup.rowCount === 0) fail('NOT_FOUND', '仕入先が見つかりません');
    await c.query(
      `UPDATE purchase_orders SET supplier_id=$3, due_date=$4, location_id=$5, external_ref=$6, supplier_note=$7, internal_memo=$8, version=version+1, updated_at=now()
       WHERE ws_id=$1 AND id=$2`,
      [ctx.wsId, poId, input.supplierId, input.dueDate, input.locationId, input.externalRef, input.supplierNote, input.internalMemo],
    );
    await c.query(`DELETE FROM po_lines WHERE ws_id=$1 AND po_id=$2`, [ctx.wsId, poId]);
    await insertLines(
      c,
      ctx.wsId,
      poId,
      input.lines.map((l) => ({ ...l, id: undefined })),
      snaps,
      1,
    );
    return { id: poId, version: version + 1 };
  });
}

export async function deleteDraft(ctx: Ctx, poId: string) {
  return writeTx(ctx, async (c) => {
    const p = await c.query(`SELECT status FROM purchase_orders WHERE ws_id=$1 AND id=$2 FOR UPDATE`, [ctx.wsId, poId]);
    if (p.rowCount === 0) fail('NOT_FOUND', '発注が見つかりません');
    if (p.rows[0].status !== 'draft') fail('STATE', '発注済みの発注は削除できません（残数打切りを使ってください）');
    await c.query(`DELETE FROM po_lines WHERE ws_id=$1 AND po_id=$2`, [ctx.wsId, poId]);
    await c.query(`DELETE FROM purchase_orders WHERE ws_id=$1 AND id=$2`, [ctx.wsId, poId]);
    return { id: poId };
  });
}

// ---------- 補充判断数量（1SKU） ----------
export async function currentBasis(c: Tx, wsId: string, skuIds: string[]) {
  const r = await c.query(
    `SELECT s.id,
       coalesce((SELECT sum(b.qty) FROM balances b JOIN locations l ON l.ws_id=b.ws_id AND l.id=b.location_id
                 WHERE b.ws_id=s.ws_id AND b.sku_id=s.id AND l.kind='normal'),0)::bigint AS u,
       coalesce((SELECT sum(pl.qty-pl.received_qty-pl.cancelled_qty) FROM po_lines pl
                 JOIN purchase_orders p ON p.ws_id=pl.ws_id AND p.id=pl.po_id
                 JOIN locations l ON l.ws_id=pl.ws_id AND l.id=pl.location_id
                 WHERE pl.ws_id=s.ws_id AND pl.sku_id=s.id AND p.status='placed' AND l.kind='normal'),0)::bigint AS o
     FROM skus s WHERE s.ws_id=$1 AND s.id = ANY($2::uuid[])`,
    [wsId, skuIds],
  );
  return new Map(r.rows.map((x) => [x.id as string, { u: Number(x.u), o: Number(x.o), p: Number(x.u) + Number(x.o) }]));
}

// ---------- 発注済みにする ----------
export async function placeOrder(ctx: Ctx, poId: string, cmd: z.infer<typeof zPoPlaceCmd>) {
  return runCommand(ctx, 'po_place', cmd.idempotencyKey, { poId, ...cmd }, async (c) => {
    const p = await c.query(`SELECT status, version FROM purchase_orders WHERE ws_id=$1 AND id=$2 FOR UPDATE`, [ctx.wsId, poId]);
    if (p.rowCount === 0) fail('NOT_FOUND', '発注が見つかりません');
    if (p.rows[0].status !== 'draft') fail('STATE', 'この発注は既に発注済みです');
    if (p.rows[0].version !== cmd.version) fail('VERSION_CONFLICT', '他の端末で下書きが更新されています。最新の内容を確認してください。');
    const lines = (await c.query(`SELECT id, sku_id, qty, basis_p FROM po_lines WHERE ws_id=$1 AND po_id=$2 ORDER BY line_no FOR UPDATE`, [ctx.wsId, poId])).rows;
    if (lines.length === 0) fail('VALIDATION', '明細がない発注は発注済みにできません');
    // 補充候補から作った明細は、作成時点の補充判断数量と最新値を比較し、変わっていれば再確認させる
    const basisSkus = lines.filter((l) => l.basis_p !== null).map((l) => l.sku_id as string);
    if (basisSkus.length) {
      const cur = await currentBasis(c, ctx.wsId, basisSkus);
      const changed = [];
      for (const l of lines) {
        if (l.basis_p === null) continue;
        const now = cur.get(l.sku_id)!;
        const ack = cmd.acknowledgedBasis[l.sku_id];
        if (now.p !== Number(l.basis_p) && ack !== now.p) {
          changed.push({ skuId: l.sku_id, basisAtDraft: Number(l.basis_p), currentP: now.p, available: now.u, onOrder: now.o, draftQty: l.qty });
        }
      }
      if (changed.length) {
        const skuInfo = await c.query(`SELECT id, code, name FROM skus WHERE ws_id=$1 AND id = ANY($2::uuid[])`, [ctx.wsId, changed.map((x) => x.skuId)]);
        const m = new Map(skuInfo.rows.map((x) => [x.id, x]));
        fail('BASIS_CHANGED', '下書き作成後に在庫または発注残が変わりました。最新の数量を確認し、数量を見直してから発注済みにしてください。', {
          changed: changed.map((x) => ({ ...x, skuCode: m.get(x.skuId)?.code, skuName: m.get(x.skuId)?.name })),
        });
      }
    }
    await c.query(`UPDATE purchase_orders SET status='placed', ordered_date=$3, version=version+1, updated_at=now() WHERE ws_id=$1 AND id=$2`, [
      ctx.wsId,
      poId,
      cmd.orderedDate,
    ]);
    await recordRevision(c, ctx.wsId, poId, 'placed', '');
    return { id: poId, version: cmd.version + 1 };
  });
}

// ---------- 発注済みの訂正（版と理由を残す） ----------
export async function revisePlaced(ctx: Ctx, poId: string, cmd: z.infer<typeof zPoReviseCmd>) {
  return runCommand(ctx, 'po_revise', cmd.idempotencyKey, { poId, ...cmd }, async (c) => {
    const p = await c.query(`SELECT status, version FROM purchase_orders WHERE ws_id=$1 AND id=$2 FOR UPDATE`, [ctx.wsId, poId]);
    if (p.rowCount === 0) fail('NOT_FOUND', '発注が見つかりません');
    if (p.rows[0].status !== 'placed') fail('STATE', '下書きは通常の編集で変更してください');
    if (p.rows[0].version !== cmd.version) fail('VERSION_CONFLICT', '他の端末で発注が更新されています。最新の内容を確認してください。');
    const cur = (await c.query(`SELECT * FROM po_lines WHERE ws_id=$1 AND po_id=$2 ORDER BY id FOR UPDATE`, [ctx.wsId, poId])).rows;
    const byId = new Map(cur.map((l) => [l.id as string, l]));
    const inputIds = new Set(cmd.lines.filter((l) => l.id).map((l) => l.id!));
    // 既存明細は削除しない（固定明細IDで入荷の対応を保つ）。減らすなら数量変更か打切り。
    for (const l of cur) {
      if (!inputIds.has(l.id)) fail('VALIDATION', '確定した発注の明細は削除できません。数量を変更するか残数を打ち切ってください。');
    }
    const snaps = await skuSnapshots(
      c,
      ctx.wsId,
      cmd.lines.filter((l) => !l.id).map((l) => l.skuId),
    );
    await checkLocations(
      c,
      ctx.wsId,
      cmd.lines.map((l) => l.locationId),
    );
    for (const l of cmd.lines) {
      if (!l.id) continue;
      const old = byId.get(l.id);
      if (!old) fail('NOT_FOUND', '明細が見つかりません');
      if (old.sku_id !== l.skuId) fail('VALIDATION', '確定した明細のSKUは変更できません。新しい明細を追加してください。');
      if (l.qty < old.received_qty + old.cancelled_qty) {
        fail('VALIDATION', `発注数量は受領済み${old.received_qty}＋打切り${old.cancelled_qty}以上にしてください`);
      }
      if (old.location_id !== l.locationId && old.received_qty > 0) fail('VALIDATION', '入荷済みの明細の納入場所は変更できません');
      await c.query(`UPDATE po_lines SET qty=$3, due_date=$4, location_id=$5 WHERE ws_id=$1 AND id=$2`, [ctx.wsId, l.id, l.qty, l.dueDate, l.locationId]);
    }
    const maxNo = cur.reduce((a, l) => Math.max(a, l.line_no), 0);
    await insertLines(
      c,
      ctx.wsId,
      poId,
      cmd.lines.filter((l) => !l.id),
      snaps,
      maxNo + 1,
    );
    await c.query(
      `UPDATE purchase_orders SET due_date=$3, external_ref=$4, supplier_note=$5, internal_memo=$6, version=version+1, updated_at=now() WHERE ws_id=$1 AND id=$2`,
      [ctx.wsId, poId, cmd.dueDate, cmd.externalRef, cmd.supplierNote, cmd.internalMemo],
    );
    await recordRevision(c, ctx.wsId, poId, 'revised', cmd.reason);
    return { id: poId, version: cmd.version + 1 };
  });
}

// ---------- 未入荷分の打切り ----------
export async function cancelRemaining(ctx: Ctx, poId: string, cmd: z.infer<typeof zPoCancelRemainingCmd>) {
  return runCommand(ctx, 'po_cancel_remaining', cmd.idempotencyKey, { poId, ...cmd }, async (c) => {
    const p = await c.query(`SELECT status, version FROM purchase_orders WHERE ws_id=$1 AND id=$2 FOR UPDATE`, [ctx.wsId, poId]);
    if (p.rowCount === 0) fail('NOT_FOUND', '発注が見つかりません');
    if (p.rows[0].status !== 'placed') fail('STATE', '下書きは削除または編集してください');
    if (p.rows[0].version !== cmd.version) fail('VERSION_CONFLICT', '他の端末で発注が更新されています。最新の内容を確認してください。');
    const res = await closeLinesTx(c, ctx.wsId, poId, cmd.lineIds);
    await c.query(`UPDATE purchase_orders SET version=version+1, updated_at=now() WHERE ws_id=$1 AND id=$2`, [ctx.wsId, poId]);
    await recordRevision(c, ctx.wsId, poId, 'cancel_remaining', cmd.reason);
    return { id: poId, version: cmd.version + 1, closed: res };
  });
}

async function closeLinesTx(c: Tx, wsId: string, poId: string, lineIds: string[]) {
  const ids = [...new Set(lineIds)].sort();
  const r = await c.query(`SELECT id, qty, received_qty, cancelled_qty FROM po_lines WHERE ws_id=$1 AND po_id=$2 AND id = ANY($3::uuid[]) ORDER BY id FOR UPDATE`, [
    wsId,
    poId,
    ids,
  ]);
  if (r.rowCount !== ids.length) fail('NOT_FOUND', '明細が見つかりません');
  const closed = [];
  for (const l of r.rows) {
    const o = l.qty - l.received_qty - l.cancelled_qty;
    if (o <= 0) continue;
    await c.query(`UPDATE po_lines SET cancelled_qty = cancelled_qty + $3 WHERE ws_id=$1 AND id=$2`, [wsId, l.id, o]);
    closed.push({ lineId: l.id, cancelled: o });
  }
  return closed;
}

// ---------- 入荷（分納・複数場所） ----------
export async function receive(ctx: Ctx, poId: string, cmd: z.infer<typeof zReceiptCmd>) {
  const seen = new Set<string>();
  for (const l of cmd.lines) {
    if (seen.has(l.poLineId)) fail('VALIDATION', '同じ明細が重複しています');
    seen.add(l.poLineId);
  }
  if (cmd.closeShortLineIds.length && !cmd.closeShortReason.trim()) fail('VALIDATION', '残数を打ち切る場合は理由（仕入先に確認した内容等）を入力してください');
  return runCommand(ctx, 'po_receive', cmd.idempotencyKey, { poId, ...cmd }, (c) => receiveTx(c, ctx, poId, cmd));
}

export async function receiveTx(c: Tx, ctx: Ctx, poId: string, cmd: z.infer<typeof zReceiptCmd>, extra: ImportExtra = {}) {
  const p = await c.query(`SELECT status, po_no FROM purchase_orders WHERE ws_id=$1 AND id=$2 FOR UPDATE`, [ctx.wsId, poId]);
  if (p.rowCount === 0) fail('NOT_FOUND', '発注が見つかりません');
  if (p.rows[0].status !== 'placed') fail('STATE', '下書きの発注には入荷できません。先に「発注済みにする」を行ってください。');
  const ids = cmd.lines.map((l) => l.poLineId).sort();
  const lr = await c.query(
    `SELECT id, sku_id, qty, received_qty, cancelled_qty FROM po_lines WHERE ws_id=$1 AND po_id=$2 AND id = ANY($3::uuid[]) ORDER BY id FOR UPDATE`,
    [ctx.wsId, poId, ids],
  );
  if (lr.rowCount !== ids.length) fail('NOT_FOUND', '発注明細が見つかりません');
  const lines = new Map(lr.rows.map((l) => [l.id as string, l]));
  const over = [];
  for (const l of cmd.lines) {
    const pl = lines.get(l.poLineId)!;
    const total = l.splits.reduce((a, s) => a + s.qty, 0);
    const o = outstanding({ qty: pl.qty, received: pl.received_qty, cancelled: pl.cancelled_qty });
    if (total > o) over.push({ poLineId: l.poLineId, outstanding: o, requested: total });
  }
  if (over.length) {
    fail('OVER_RECEIPT', `発注残より多い数量は入荷できません（発注残${over[0].outstanding}、今回${over[0].requested}）。発注の訂正、または発注外入庫を使ってください。`, { over });
  }
  const movements: Movement[] = [];
  for (const l of cmd.lines) {
    const pl = lines.get(l.poLineId)!;
    const locSeen = new Set<string>();
    for (const s of l.splits) {
      if (locSeen.has(s.locationId)) fail('VALIDATION', '同じ明細で同じ入庫先が重複しています');
      locSeen.add(s.locationId);
      movements.push({ skuId: pl.sku_id, locationId: s.locationId, delta: s.qty, kind: 'po_receipt', poLineId: l.poLineId });
    }
  }
  const result = await applyOperation(c, ctx, {
    kind: 'po_receipt',
    businessDate: cmd.businessDate,
    note: cmd.note,
    poId,
    ...extra,
    expected: cmd.expected,
    movements,
  });
  for (const l of cmd.lines) {
    const total = l.splits.reduce((a, s) => a + s.qty, 0);
    await c.query(`UPDATE po_lines SET received_qty = received_qty + $3 WHERE ws_id=$1 AND id=$2`, [ctx.wsId, l.poLineId, total]);
  }
  let closed: { lineId: string; cancelled: number }[] = [];
  if (cmd.closeShortLineIds.length) {
    closed = await closeLinesTx(c, ctx.wsId, poId, cmd.closeShortLineIds);
    await c.query(`UPDATE purchase_orders SET version=version+1, updated_at=now() WHERE ws_id=$1 AND id=$2`, [ctx.wsId, poId]);
    await recordRevision(c, ctx.wsId, poId, 'cancel_remaining', cmd.closeShortReason);
  }
  return { ...result, poNo: p.rows[0].po_no as string, closed };
}

// ---------- 参照 ----------
export async function getPo(ctx: Ctx, poId: string) {
  return readTx(ctx, async (c) => {
    const p = await c.query(
      `SELECT p.*, s.name AS supplier_name, s.code AS supplier_code, l.name AS location_name FROM purchase_orders p
       JOIN suppliers s ON s.ws_id=p.ws_id AND s.id=p.supplier_id LEFT JOIN locations l ON l.ws_id=p.ws_id AND l.id=p.location_id
       WHERE p.ws_id=$1 AND p.id=$2`,
      [ctx.wsId, poId],
    );
    if (p.rowCount === 0) fail('NOT_FOUND', '発注が見つかりません');
    const lines = await c.query(
      `SELECT pl.*, s.code AS sku_code, s.name AS sku_name, s.color, s.size, s.unit, s.photo_file_id, l.name AS location_name, l.kind AS location_kind
       FROM po_lines pl JOIN skus s ON s.ws_id=pl.ws_id AND s.id=pl.sku_id JOIN locations l ON l.ws_id=pl.ws_id AND l.id=pl.location_id
       WHERE pl.ws_id=$1 AND pl.po_id=$2 ORDER BY pl.line_no`,
      [ctx.wsId, poId],
    );
    const receipts = await c.query(
      `SELECT e.id AS event_id, e.po_line_id, e.qty, e.kind, e.business_date, e.committed_at, e.reversal_of_event_id, o.op_no, o.id AS op_id, l.name AS location_name
       FROM ledger_events e JOIN operations o ON o.ws_id=e.ws_id AND o.id=e.op_id JOIN locations l ON l.ws_id=e.ws_id AND l.id=e.location_id
       WHERE e.ws_id=$1 AND e.po_line_id IN (SELECT id FROM po_lines WHERE ws_id=$1 AND po_id=$2) ORDER BY e.seq`,
      [ctx.wsId, poId],
    );
    const revisions = await c.query(`SELECT version, action, reason, created_at FROM po_revisions WHERE ws_id=$1 AND po_id=$2 ORDER BY created_at`, [ctx.wsId, poId]);
    const po = p.rows[0];
    const ls = lines.rows.map((l) => ({
      id: l.id,
      lineNo: l.line_no,
      skuId: l.sku_id,
      skuCode: l.sku_code,
      skuName: l.sku_name,
      color: l.color,
      size: l.size,
      unit: l.unit,
      photoFileId: l.photo_file_id,
      qty: l.qty,
      received: l.received_qty,
      cancelled: l.cancelled_qty,
      outstanding: l.qty - l.received_qty - l.cancelled_qty,
      dueDate: l.due_date,
      locationId: l.location_id,
      locationName: l.location_name,
      locationKind: l.location_kind,
      basisP: l.basis_p,
      snapshot: l.sku_snapshot,
    }));
    const status = poDisplayStatus(
      po.status,
      ls.map((l) => ({ qty: l.qty, received: l.received, cancelled: l.cancelled })),
    );
    return {
      id: po.id,
      poNo: po.po_no,
      status: po.status,
      displayStatus: status,
      displayStatusLabel: PO_STATUS_LABEL[status],
      supplierId: po.supplier_id,
      supplierName: po.supplier_name,
      supplierCode: po.supplier_code,
      createdDate: po.created_date,
      orderedDate: po.ordered_date,
      dueDate: po.due_date,
      locationId: po.location_id,
      locationName: po.location_name,
      externalRef: po.external_ref,
      supplierNote: po.supplier_note,
      internalMemo: po.internal_memo,
      replacesPoId: po.replaces_po_id,
      version: po.version,
      lines: ls,
      receipts: receipts.rows.map((r) => ({
        eventId: r.event_id,
        poLineId: r.po_line_id,
        qty: r.qty,
        kind: r.kind,
        businessDate: r.business_date,
        committedAt: r.committed_at,
        opNo: r.op_no,
        opId: r.op_id,
        locationName: r.location_name,
        reversalOf: r.reversal_of_event_id,
      })),
      revisions: revisions.rows,
    };
  });
}

export interface PoListFilter {
  status?: 'draft' | 'open' | 'closed' | 'all';
  supplierId?: string;
  q?: string;
  overdue?: boolean;
  partial?: boolean;
  skuId?: string;
  limit?: number;
  offset?: number;
}

export async function listPos(ctx: Ctx, f: PoListFilter) {
  const t = today(ctx);
  return readTx(ctx, async (c) => {
    const params: unknown[] = [ctx.wsId, t];
    const where: string[] = ['p.ws_id=$1'];
    if (f.supplierId) {
      params.push(f.supplierId);
      where.push(`p.supplier_id=$${params.length}`);
    }
    if (f.skuId) {
      params.push(f.skuId);
      where.push(`EXISTS (SELECT 1 FROM po_lines x WHERE x.ws_id=p.ws_id AND x.po_id=p.id AND x.sku_id=$${params.length})`);
    }
    if (f.q) {
      params.push(`%${f.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
      where.push(
        `(p.po_no ILIKE $${params.length} OR p.external_ref ILIKE $${params.length} OR s.name ILIKE $${params.length} OR EXISTS (SELECT 1 FROM po_lines x JOIN skus k ON k.ws_id=x.ws_id AND k.id=x.sku_id WHERE x.ws_id=p.ws_id AND x.po_id=p.id AND (k.code ILIKE $${params.length} OR k.name ILIKE $${params.length})))`,
      );
    }
    const limit = Math.min(f.limit ?? 50, 200);
    params.push(limit, f.offset ?? 0);
    const r = await c.query(
      `WITH agg AS (
         SELECT p.id, sum(pl.qty)::bigint q, sum(pl.received_qty)::bigint r, sum(pl.cancelled_qty)::bigint cq, count(pl.id)::int n,
           bool_or(pl.qty-pl.received_qty-pl.cancelled_qty>0 AND coalesce(pl.due_date,p.due_date) < $2::date) AS overdue,
           min(CASE WHEN pl.qty-pl.received_qty-pl.cancelled_qty>0 THEN coalesce(pl.due_date,p.due_date) END) AS next_due
         FROM purchase_orders p LEFT JOIN po_lines pl ON pl.ws_id=p.ws_id AND pl.po_id=p.id WHERE p.ws_id=$1 GROUP BY p.id)
       SELECT p.id, p.po_no, p.status, p.created_date, p.ordered_date, p.due_date, p.external_ref, p.version, s.name supplier_name, s.id supplier_id,
         a.q, a.r, a.cq, a.n, a.overdue, a.next_due
       FROM purchase_orders p JOIN suppliers s ON s.ws_id=p.ws_id AND s.id=p.supplier_id JOIN agg a ON a.id=p.id
       WHERE ${where.join(' AND ')}
       ORDER BY p.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    let rows = r.rows.map((x) => {
      const q = Number(x.q ?? 0);
      const rr = Number(x.r ?? 0);
      const cq = Number(x.cq ?? 0);
      const ds = x.status === 'draft' ? 'draft' : poDisplayStatus('placed', [{ qty: q, received: rr, cancelled: cq }]);
      return {
        id: x.id,
        poNo: x.po_no,
        status: x.status,
        displayStatus: ds,
        displayStatusLabel: PO_STATUS_LABEL[ds],
        supplierId: x.supplier_id,
        supplierName: x.supplier_name,
        createdDate: x.created_date,
        orderedDate: x.ordered_date,
        dueDate: x.due_date,
        nextDue: x.next_due,
        externalRef: x.external_ref,
        lineCount: x.n,
        qty: q,
        received: rr,
        cancelled: cq,
        outstanding: q - rr - cq,
        overdue: x.status === 'placed' && !!x.overdue,
        version: x.version,
      };
    });
    if (f.status === 'draft') rows = rows.filter((x) => x.status === 'draft');
    if (f.status === 'open') rows = rows.filter((x) => x.status === 'placed' && x.outstanding > 0);
    if (f.status === 'closed') rows = rows.filter((x) => x.status === 'placed' && x.outstanding === 0);
    if (f.overdue) rows = rows.filter((x) => x.overdue);
    if (f.partial) rows = rows.filter((x) => x.displayStatus === 'partial');
    return rows;
  });
}

/** 入荷待ち明細（仕入先・納期・SKU・部分入荷・納期超過で絞込） */
export async function listPendingLines(ctx: Ctx, f: { supplierId?: string; skuId?: string; overdue?: boolean; partial?: boolean; q?: string; limit?: number; offset?: number }) {
  const t = today(ctx);
  return readTx(ctx, async (c) => {
    const params: unknown[] = [ctx.wsId, t];
    const where = [`p.ws_id=$1`, `p.status='placed'`, `pl.qty-pl.received_qty-pl.cancelled_qty>0`];
    if (f.supplierId) {
      params.push(f.supplierId);
      where.push(`p.supplier_id=$${params.length}`);
    }
    if (f.skuId) {
      params.push(f.skuId);
      where.push(`pl.sku_id=$${params.length}`);
    }
    if (f.overdue) where.push(`coalesce(pl.due_date,p.due_date) < $2::date`);
    if (f.partial) where.push(`pl.received_qty > 0`);
    if (f.q) {
      params.push(`%${f.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
      where.push(`(p.po_no ILIKE $${params.length} OR k.code ILIKE $${params.length} OR k.name ILIKE $${params.length} OR s.name ILIKE $${params.length})`);
    }
    params.push(Math.min(f.limit ?? 100, 200), f.offset ?? 0);
    const r = await c.query(
      `SELECT pl.id, pl.po_id, p.po_no, s.name supplier_name, pl.sku_id, k.code sku_code, k.name sku_name, k.color, k.size, k.unit, k.photo_file_id,
         pl.qty, pl.received_qty, pl.cancelled_qty, coalesce(pl.due_date,p.due_date) due_date, l.name location_name, p.ordered_date,
         coalesce(pl.due_date,p.due_date) < $2::date AS overdue
       FROM po_lines pl JOIN purchase_orders p ON p.ws_id=pl.ws_id AND p.id=pl.po_id
       JOIN suppliers s ON s.ws_id=p.ws_id AND s.id=p.supplier_id JOIN skus k ON k.ws_id=pl.ws_id AND k.id=pl.sku_id
       JOIN locations l ON l.ws_id=pl.ws_id AND l.id=pl.location_id
       WHERE ${where.join(' AND ')}
       ORDER BY coalesce(pl.due_date,p.due_date) NULLS LAST, p.po_no, pl.line_no LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return r.rows.map((x) => ({
      id: x.id,
      poId: x.po_id,
      poNo: x.po_no,
      supplierName: x.supplier_name,
      skuId: x.sku_id,
      skuCode: x.sku_code,
      skuName: x.sku_name,
      color: x.color,
      size: x.size,
      unit: x.unit,
      photoFileId: x.photo_file_id,
      qty: x.qty,
      received: x.received_qty,
      cancelled: x.cancelled_qty,
      outstanding: x.qty - x.received_qty - x.cancelled_qty,
      dueDate: x.due_date,
      overdue: !!x.overdue,
      locationName: x.location_name,
      orderedDate: x.ordered_date,
    }));
  });
}

export { computeReplenishment };
