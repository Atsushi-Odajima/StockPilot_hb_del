import type { Tx } from '../db/pool.js';
import { fail } from '../errors.js';
import { codeKey, validateBarcode, type BarcodeKind } from '../../shared/codes.js';
import { validateReplenishSettings } from '../../domain/replenish.js';
import type { LocationInput, SkuInput, SupplierInput } from '../../shared/schemas.js';
import { type Ctx, uuid, writeTx, readTx, sha256 } from './context.js';
import { sniffImage } from '../storage.js';
import { PHOTO_MAX_BYTES } from '../../shared/limits.js';

function uniqueViolation(e: unknown, constraintPart: string): boolean {
  const err = e as { code?: string; constraint?: string };
  return err.code === '23505' && (err.constraint ?? '').includes(constraintPart);
}

// ---------- 仕入先 ----------
export async function createSupplier(ctx: Ctx, input: SupplierInput) {
  return writeTx(ctx, (c) => insertSupplier(c, ctx.wsId, input));
}

export async function insertSupplier(c: Tx, wsId: string, input: SupplierInput, id = uuid()) {
  try {
    await c.query(
      `INSERT INTO suppliers (ws_id,id,code,code_key,name,contact_name,contact,lead_time_days,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [wsId, id, input.code, codeKey(input.code), input.name, input.contactName, input.contact, input.leadTimeDays, input.note],
    );
  } catch (e) {
    if (uniqueViolation(e, 'code_key')) fail('DUPLICATE', `仕入先コード「${input.code}」は既に使われています（大小文字・前後空白の違いは同一扱い）`);
    throw e;
  }
  return { id };
}

export async function updateSupplier(ctx: Ctx, id: string, version: number, input: SupplierInput) {
  return writeTx(ctx, async (c) => {
    try {
      const r = await c.query(
        `UPDATE suppliers SET code=$3,code_key=$4,name=$5,contact_name=$6,contact=$7,lead_time_days=$8,note=$9,version=version+1,updated_at=now()
         WHERE ws_id=$1 AND id=$2 AND version=$10 RETURNING version`,
        [ctx.wsId, id, input.code, codeKey(input.code), input.name, input.contactName, input.contact, input.leadTimeDays, input.note, version],
      );
      if (r.rowCount === 0) await versionOrNotFound(c, 'suppliers', ctx.wsId, id);
      return { id, version: r.rows[0].version as number };
    } catch (e) {
      if (uniqueViolation(e, 'code_key')) fail('DUPLICATE', `仕入先コード「${input.code}」は既に使われています`);
      throw e;
    }
  });
}

export async function setSupplierArchived(ctx: Ctx, id: string, archived: boolean) {
  return writeTx(ctx, async (c) => {
    if (archived) {
      const open = await c.query(
        `SELECT count(*)::int n FROM purchase_orders p JOIN po_lines l ON l.ws_id=p.ws_id AND l.po_id=p.id
         WHERE p.ws_id=$1 AND p.supplier_id=$2 AND (p.status='draft' OR l.qty-l.received_qty-l.cancelled_qty>0)`,
        [ctx.wsId, id],
      );
      if (open.rows[0].n > 0) fail('IN_USE', '下書きまたは発注残のある発注があるため、アーカイブできません');
    }
    const r = await c.query(`UPDATE suppliers SET archived=$3, version=version+1, updated_at=now() WHERE ws_id=$1 AND id=$2`, [ctx.wsId, id, archived]);
    if (r.rowCount === 0) fail('NOT_FOUND', '仕入先が見つかりません');
    return { id };
  });
}

// ---------- ロケーション ----------
export async function createLocation(ctx: Ctx, input: LocationInput) {
  return writeTx(ctx, (c) => insertLocation(c, ctx.wsId, input));
}

export async function insertLocation(c: Tx, wsId: string, input: LocationInput, id = uuid()) {
  try {
    await c.query(`INSERT INTO locations (ws_id,id,code,code_key,name,description,kind) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      wsId,
      id,
      input.code,
      codeKey(input.code),
      input.name,
      input.description,
      input.kind,
    ]);
  } catch (e) {
    if (uniqueViolation(e, 'code_key')) fail('DUPLICATE', `場所コード「${input.code}」は既に使われています`);
    throw e;
  }
  return { id };
}

export async function updateLocation(ctx: Ctx, id: string, version: number, input: LocationInput) {
  return writeTx(ctx, async (c) => {
    const cur = await c.query(`SELECT kind, version FROM locations WHERE ws_id=$1 AND id=$2 FOR UPDATE`, [ctx.wsId, id]);
    if (cur.rowCount === 0) fail('NOT_FOUND', '場所が見つかりません');
    if (cur.rows[0].version !== version) fail('VERSION_CONFLICT', '他の端末で更新されています。最新の内容を確認してください。');
    if (cur.rows[0].kind !== input.kind) {
      const st = await c.query(`SELECT coalesce(sum(qty),0)::bigint n FROM balances WHERE ws_id=$1 AND location_id=$2`, [ctx.wsId, id]);
      if (st.rows[0].n > 0) {
        fail('IN_USE', '在庫がある場所の「通常／保留」は切り替えられません。別の場所を作成して移動してください。');
      }
    }
    try {
      const r = await c.query(
        `UPDATE locations SET code=$3,code_key=$4,name=$5,description=$6,kind=$7,version=version+1,updated_at=now() WHERE ws_id=$1 AND id=$2 RETURNING version`,
        [ctx.wsId, id, input.code, codeKey(input.code), input.name, input.description, input.kind],
      );
      return { id, version: r.rows[0].version as number };
    } catch (e) {
      if (uniqueViolation(e, 'code_key')) fail('DUPLICATE', `場所コード「${input.code}」は既に使われています`);
      throw e;
    }
  });
}

async function locationUsage(c: Tx, wsId: string, id: string) {
  const r = await c.query(
    `SELECT
       (SELECT coalesce(sum(qty),0) FROM balances WHERE ws_id=$1 AND location_id=$2)::bigint AS stock,
       (SELECT count(*) FROM po_lines l JOIN purchase_orders p ON p.ws_id=l.ws_id AND p.id=l.po_id
          WHERE l.ws_id=$1 AND l.location_id=$2 AND (p.status='draft' OR l.qty-l.received_qty-l.cancelled_qty>0))::int AS open_po,
       (SELECT count(*) FROM stocktakes WHERE ws_id=$1 AND location_id=$2 AND status IN ('counting','review'))::int AS active_st,
       (SELECT count(*) FROM ledger_events WHERE ws_id=$1 AND location_id=$2)::int AS events,
       (SELECT count(*) FROM po_lines WHERE ws_id=$1 AND location_id=$2)::int AS po_refs,
       (SELECT count(*) FROM stocktakes WHERE ws_id=$1 AND location_id=$2)::int AS st_refs,
       (SELECT count(*) FROM purchase_orders WHERE ws_id=$1 AND location_id=$2)::int AS po_head_refs`,
    [wsId, id],
  );
  return r.rows[0] as { stock: number; open_po: number; active_st: number; events: number; po_refs: number; st_refs: number; po_head_refs: number };
}

export async function setLocationArchived(ctx: Ctx, id: string, archived: boolean) {
  return writeTx(ctx, async (c) => {
    const l = await c.query(`SELECT id FROM locations WHERE ws_id=$1 AND id=$2 FOR UPDATE`, [ctx.wsId, id]);
    if (l.rowCount === 0) fail('NOT_FOUND', '場所が見つかりません');
    if (archived) {
      const u = await locationUsage(c, ctx.wsId, id);
      if (u.stock > 0) fail('IN_USE', `この場所に在庫が${u.stock}残っています。移動してからアーカイブしてください。`);
      if (u.open_po > 0) fail('IN_USE', '入荷予定の発注がこの場所を納入先にしています');
      if (u.active_st > 0) fail('IN_USE', '棚卸中の場所はアーカイブできません');
    }
    await c.query(`UPDATE locations SET archived=$3, version=version+1, updated_at=now() WHERE ws_id=$1 AND id=$2`, [ctx.wsId, id, archived]);
    return { id };
  });
}

export async function deleteLocation(ctx: Ctx, id: string) {
  return writeTx(ctx, async (c) => {
    const l = await c.query(`SELECT id FROM locations WHERE ws_id=$1 AND id=$2 FOR UPDATE`, [ctx.wsId, id]);
    if (l.rowCount === 0) fail('NOT_FOUND', '場所が見つかりません');
    const u = await locationUsage(c, ctx.wsId, id);
    if (u.stock > 0 || u.events > 0 || u.po_refs > 0 || u.st_refs > 0 || u.po_head_refs > 0) {
      fail('IN_USE', '在庫・履歴・発注・棚卸の参照がある場所は削除できません（アーカイブを使ってください）');
    }
    await c.query(`DELETE FROM balances WHERE ws_id=$1 AND location_id=$2`, [ctx.wsId, id]);
    await c.query(`DELETE FROM locations WHERE ws_id=$1 AND id=$2`, [ctx.wsId, id]);
    return { id };
  });
}

// ---------- SKU ----------
function skuParams(input: SkuInput) {
  const r = input.replenish;
  if (r) {
    const err = validateReplenishSettings(r);
    if (err) fail('VALIDATION', err);
  }
  return [
    input.code,
    codeKey(input.code),
    input.name,
    input.groupName,
    input.color,
    input.size,
    input.attrs,
    input.category,
    input.brand,
    input.unit,
    input.supplierId,
    input.memo,
    r?.safetyStock ?? null,
    r?.reorderPoint ?? null,
    r?.targetStock ?? null,
    r?.minOrderQty ?? null,
    r?.orderMultiple ?? null,
    input.leadTimeDays,
  ];
}

async function checkSupplier(c: Tx, wsId: string, supplierId: string | null) {
  if (!supplierId) return;
  const r = await c.query(`SELECT 1 FROM suppliers WHERE ws_id=$1 AND id=$2`, [wsId, supplierId]);
  if (r.rowCount === 0) fail('VALIDATION', '標準仕入先が見つかりません');
}

export async function createSku(ctx: Ctx, input: SkuInput) {
  return writeTx(ctx, (c) => insertSku(c, ctx.wsId, input));
}

export async function insertSku(c: Tx, wsId: string, input: SkuInput, id = uuid()) {
  await checkSupplier(c, wsId, input.supplierId);
  try {
    await c.query(
      `INSERT INTO skus (ws_id,id,code,code_key,name,group_name,color,size,attrs,category,brand,unit,supplier_id,memo,
         safety_stock,reorder_point,target_stock,min_order_qty,order_multiple,lead_time_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [wsId, id, ...skuParams(input)],
    );
  } catch (e) {
    if (uniqueViolation(e, 'code_key')) {
      fail('DUPLICATE', `SKUコード「${input.code}」は既に登録されています（大小文字・前後空白の違いは同一扱い）`);
    }
    throw e;
  }
  return { id };
}

export async function updateSku(ctx: Ctx, id: string, version: number, input: SkuInput) {
  return writeTx(ctx, async (c) => {
    await checkSupplier(c, ctx.wsId, input.supplierId);
    try {
      const r = await c.query(
        `UPDATE skus SET code=$3,code_key=$4,name=$5,group_name=$6,color=$7,size=$8,attrs=$9,category=$10,brand=$11,unit=$12,
           supplier_id=$13,memo=$14,safety_stock=$15,reorder_point=$16,target_stock=$17,min_order_qty=$18,order_multiple=$19,lead_time_days=$20,
           version=version+1, updated_at=now()
         WHERE ws_id=$1 AND id=$2 AND version=$21 RETURNING version`,
        [ctx.wsId, id, ...skuParams(input), version],
      );
      if (r.rowCount === 0) await versionOrNotFound(c, 'skus', ctx.wsId, id);
      return { id, version: r.rows[0].version as number };
    } catch (e) {
      if (uniqueViolation(e, 'code_key')) fail('DUPLICATE', `SKUコード「${input.code}」は既に登録されています`);
      throw e;
    }
  });
}

async function skuUsage(c: Tx, wsId: string, id: string) {
  const r = await c.query(
    `SELECT
       (SELECT coalesce(sum(qty),0) FROM balances WHERE ws_id=$1 AND sku_id=$2)::bigint AS stock,
       (SELECT coalesce(sum(l.qty-l.received_qty-l.cancelled_qty),0) FROM po_lines l JOIN purchase_orders p ON p.ws_id=l.ws_id AND p.id=l.po_id
          WHERE l.ws_id=$1 AND l.sku_id=$2 AND p.status='placed')::bigint AS on_order,
       (SELECT count(*) FROM po_lines l JOIN purchase_orders p ON p.ws_id=l.ws_id AND p.id=l.po_id WHERE l.ws_id=$1 AND l.sku_id=$2 AND p.status='draft')::int AS drafts,
       (SELECT count(*) FROM stocktake_lines sl JOIN stocktakes s ON s.ws_id=sl.ws_id AND s.id=sl.stocktake_id
          WHERE sl.ws_id=$1 AND sl.sku_id=$2 AND s.status IN ('counting','review'))::int AS active_st,
       (SELECT count(*) FROM ledger_events WHERE ws_id=$1 AND sku_id=$2)::int AS events,
       (SELECT count(*) FROM po_lines WHERE ws_id=$1 AND sku_id=$2)::int AS po_refs,
       (SELECT count(*) FROM stocktake_lines WHERE ws_id=$1 AND sku_id=$2)::int AS st_refs`,
    [wsId, id],
  );
  return r.rows[0] as { stock: number; on_order: number; drafts: number; active_st: number; events: number; po_refs: number; st_refs: number };
}

export async function setSkuArchived(ctx: Ctx, id: string, archived: boolean) {
  return writeTx(ctx, async (c) => {
    const s = await c.query(`SELECT id FROM skus WHERE ws_id=$1 AND id=$2 FOR UPDATE`, [ctx.wsId, id]);
    if (s.rowCount === 0) fail('NOT_FOUND', 'SKUが見つかりません');
    if (archived) {
      const u = await skuUsage(c, ctx.wsId, id);
      if (u.stock > 0) fail('IN_USE', `在庫が${u.stock}残っているためアーカイブできません`);
      if (u.on_order > 0) fail('IN_USE', `発注残が${u.on_order}あるためアーカイブできません（打切りまたは入荷後に行ってください）`);
      if (u.active_st > 0) fail('IN_USE', '棚卸対象になっているためアーカイブできません');
    }
    await c.query(`UPDATE skus SET archived=$3, version=version+1, updated_at=now() WHERE ws_id=$1 AND id=$2`, [ctx.wsId, id, archived]);
    return { id };
  });
}

export async function deleteSku(ctx: Ctx, id: string) {
  return writeTx(ctx, async (c) => {
    const s = await c.query(`SELECT id FROM skus WHERE ws_id=$1 AND id=$2 FOR UPDATE`, [ctx.wsId, id]);
    if (s.rowCount === 0) fail('NOT_FOUND', 'SKUが見つかりません');
    const u = await skuUsage(c, ctx.wsId, id);
    if (u.stock > 0 || u.events > 0 || u.po_refs > 0 || u.st_refs > 0) {
      fail('IN_USE', '在庫・履歴・発注・棚卸の参照があるSKUは削除できません（アーカイブを使ってください）');
    }
    await c.query(`DELETE FROM balances WHERE ws_id=$1 AND sku_id=$2`, [ctx.wsId, id]);
    await c.query(`DELETE FROM skus WHERE ws_id=$1 AND id=$2`, [ctx.wsId, id]);
    return { id };
  });
}

export async function addSkuCode(ctx: Ctx, skuId: string, code: string, kind: BarcodeKind) {
  return writeTx(ctx, (c) => insertSkuCode(c, ctx.wsId, skuId, code, kind));
}

export async function insertSkuCode(c: Tx, wsId: string, skuId: string, code: string, kind: BarcodeKind, id = uuid()) {
  const v = validateBarcode(code, kind);
  if (!v.ok) fail('VALIDATION', v.message!);
  const s = await c.query(`SELECT 1 FROM skus WHERE ws_id=$1 AND id=$2`, [wsId, skuId]);
  if (s.rowCount === 0) fail('NOT_FOUND', 'SKUが見つかりません');
  try {
    await c.query(`INSERT INTO sku_codes (ws_id,id,sku_id,code,kind) VALUES ($1,$2,$3,$4,$5)`, [wsId, id, skuId, code, kind]);
  } catch (e) {
    if (uniqueViolation(e, 'sku_codes')) {
      const other = await c.query(`SELECT s.code, s.name FROM sku_codes k JOIN skus s ON s.ws_id=k.ws_id AND s.id=k.sku_id WHERE k.ws_id=$1 AND k.code=$2`, [
        wsId,
        code,
      ]);
      const o = other.rows[0];
      fail('DUPLICATE', `コード「${code}」は既に${o ? `SKU「${o.code} ${o.name}」` : '別のSKU'}に登録されています`);
    }
    throw e;
  }
  return { id };
}

export async function removeSkuCode(ctx: Ctx, skuId: string, codeId: string) {
  return writeTx(ctx, async (c) => {
    const r = await c.query(`DELETE FROM sku_codes WHERE ws_id=$1 AND sku_id=$2 AND id=$3`, [ctx.wsId, skuId, codeId]);
    if (r.rowCount === 0) fail('NOT_FOUND', 'コードが見つかりません');
    return { id: codeId };
  });
}

export async function setSkuPhoto(ctx: Ctx, skuId: string, data: Buffer | null) {
  let fileRow: { sha: string; mime: string; size: number } | null = null;
  if (data) {
    if (data.length === 0) fail('VALIDATION', '空のファイルです');
    if (data.length > PHOTO_MAX_BYTES) fail('TOO_LARGE', `写真は${PHOTO_MAX_BYTES / 1024 / 1024}MBまでです`);
    const mime = sniffImage(data);
    if (mime === 'image/heic') {
      fail('VALIDATION', 'HEIC形式の写真はこのブラウザから送られた形式のままでは登録できません。iPhoneの設定「カメラ→フォーマット→互換性優先」でJPEGにするか、JPEG/PNGの写真を選んでください。');
    }
    if (!mime) fail('VALIDATION', '写真は JPEG / PNG / WEBP のみ登録できます');
    const sha = await ctx.storage.put(data);
    fileRow = { sha, mime, size: data.length };
  }
  return writeTx(ctx, async (c) => {
    let fileId: string | null = null;
    if (fileRow) {
      fileId = uuid();
      await c.query(`INSERT INTO files (ws_id,id,sha256,size,mime) VALUES ($1,$2,$3,$4,$5)`, [ctx.wsId, fileId, fileRow.sha, fileRow.size, fileRow.mime]);
    }
    const r = await c.query(`UPDATE skus SET photo_file_id=$3, version=version+1, updated_at=now() WHERE ws_id=$1 AND id=$2 RETURNING version`, [
      ctx.wsId,
      skuId,
      fileId,
    ]);
    if (r.rowCount === 0) fail('NOT_FOUND', 'SKUが見つかりません');
    return { fileId, version: r.rows[0].version as number };
  });
}

export async function getFile(ctx: Ctx, fileId: string) {
  const r = await readTx(ctx, (c) => c.query(`SELECT sha256, mime FROM files WHERE ws_id=$1 AND id=$2`, [ctx.wsId, fileId]));
  if (r.rowCount === 0) fail('NOT_FOUND', 'ファイルが見つかりません');
  const buf = await ctx.storage.get(r.rows[0].sha256);
  if (!buf || sha256(buf) !== r.rows[0].sha256) fail('NOT_FOUND', 'ファイルの実体が見つかりません');
  return { data: buf!, mime: r.rows[0].mime as string };
}

async function versionOrNotFound(c: Tx, table: 'skus' | 'suppliers' | 'locations', wsId: string, id: string): Promise<never> {
  const r = await c.query(`SELECT version FROM ${table} WHERE ws_id=$1 AND id=$2`, [wsId, id]);
  if (r.rowCount === 0) fail('NOT_FOUND', '対象が見つかりません');
  return fail('VERSION_CONFLICT', '他の端末で更新されています。最新の内容を読み込んでから編集してください。', { currentVersion: r.rows[0].version });
}
