// 棚卸（INVENTORY_RULES.md §棚卸）
// 1セッション＝1ロケーション。開始時に場所を業務上停止し、確定・中止まで全経路の在庫書込みを拒否する。
import type { z } from 'zod';
import type { Tx } from '../db/pool.js';
import { fail } from '../errors.js';
import { type Ctx, runCommand, uuid, writeTx, readTx } from './context.js';
import { applyOperation, lockLocations } from './inventory.js';
import type {
  zStocktakeStartCmd,
  zStocktakeCountInput,
  zStocktakeReasonInput,
  zStocktakeConfirmCmd,
  zStocktakeCancelCmd,
} from '../../shared/schemas.js';
import { STOCKTAKE_REASONS } from '../../shared/schemas.js';

export async function startStocktake(ctx: Ctx, cmd: z.infer<typeof zStocktakeStartCmd>) {
  return runCommand(ctx, 'stocktake_start', cmd.idempotencyKey, cmd, async (c) => {
    // 場所の制御行をロック：実行中の入出庫とは順番に処理される
    const locs = await lockLocations(c, ctx.wsId, [cmd.locationId]);
    const loc = locs.get(cmd.locationId)!;
    if (loc.archived) fail('STATE', 'アーカイブ済みの場所は棚卸できません');
    if (loc.stocktake_id) fail('LOCATION_LOCKED', `「${loc.name}」は既に棚卸中です`, { stocktakeId: loc.stocktake_id });
    const rev = (await c.query(`SELECT rev FROM locations WHERE ws_id=$1 AND id=$2`, [ctx.wsId, cmd.locationId])).rows[0].rev;
    const bal = await c.query(`SELECT sku_id, qty FROM balances WHERE ws_id=$1 AND location_id=$2 AND qty > 0 ORDER BY sku_id`, [ctx.wsId, cmd.locationId]);
    const seq = await c.query(`UPDATE workspaces SET st_seq = st_seq + 1 WHERE id=$1 RETURNING st_seq`, [ctx.wsId]);
    const stNo = `ST-${String(seq.rows[0].st_seq).padStart(5, '0')}`;
    const id = uuid();
    await c.query(`INSERT INTO stocktakes (ws_id,id,st_no,location_id,status,base_rev,business_date,started_at) VALUES ($1,$2,$3,$4,'counting',$5,$6,$7)`, [
      ctx.wsId,
      id,
      stNo,
      cmd.locationId,
      rev,
      cmd.businessDate,
      ctx.now(),
    ]);
    if (bal.rowCount) {
      await c.query(
        `INSERT INTO stocktake_lines (ws_id,id,stocktake_id,sku_id,theoretical_qty) SELECT $1, gen_random_uuid(), $2, s, q FROM unnest($3::uuid[], $4::bigint[]) AS t(s,q)`,
        [ctx.wsId, id, bal.rows.map((b) => b.sku_id), bal.rows.map((b) => b.qty)],
      );
    }
    await c.query(`UPDATE locations SET stocktake_id=$3 WHERE ws_id=$1 AND id=$2`, [ctx.wsId, cmd.locationId, id]);
    return { id, stNo, lineCount: bal.rowCount ?? 0 };
  });
}

async function lockActive(c: Tx, wsId: string, stId: string) {
  const r = await c.query(`SELECT id, status, location_id, base_rev, version, st_no, business_date FROM stocktakes WHERE ws_id=$1 AND id=$2 FOR UPDATE`, [wsId, stId]);
  if (r.rowCount === 0) fail('NOT_FOUND', '棚卸が見つかりません');
  const st = r.rows[0];
  if (st.status !== 'counting' && st.status !== 'review') fail('STATE', 'この棚卸は既に確定または中止されています');
  return st;
}

export async function recordCount(ctx: Ctx, stId: string, input: z.infer<typeof zStocktakeCountInput>) {
  return writeTx(ctx, async (c) => {
    const st = await lockActive(c, ctx.wsId, stId);
    const r = await c.query(
      `UPDATE stocktake_lines SET counted_qty=$4, version=version+1, updated_at=now(),
         reason_code = CASE WHEN $4::bigint IS NOT NULL AND $4::bigint = theoretical_qty THEN NULL ELSE reason_code END
       WHERE ws_id=$1 AND stocktake_id=$2 AND id=$3 AND version=$5 RETURNING version, counted_qty, theoretical_qty`,
      [ctx.wsId, stId, input.lineId, input.countedQty, input.version],
    );
    if (r.rowCount === 0) {
      const cur = await c.query(`SELECT version, counted_qty FROM stocktake_lines WHERE ws_id=$1 AND stocktake_id=$2 AND id=$3`, [ctx.wsId, stId, input.lineId]);
      if (cur.rowCount === 0) fail('NOT_FOUND', '棚卸行が見つかりません');
      fail('VERSION_CONFLICT', `他の端末でこの行が更新されています（現在の入力値: ${cur.rows[0].counted_qty ?? '未計数'}）。確認してから入力し直してください。`, {
        currentVersion: cur.rows[0].version,
        countedQty: cur.rows[0].counted_qty,
      });
    }
    await c.query(`INSERT INTO stocktake_count_history (ws_id,id,line_id,counted_qty) VALUES ($1,$2,$3,$4)`, [ctx.wsId, uuid(), input.lineId, input.countedQty]);
    // 再計数したら差異確認済みを解除
    if (st.status === 'review') await c.query(`UPDATE stocktakes SET status='counting', version=version+1 WHERE ws_id=$1 AND id=$2`, [ctx.wsId, stId]);
    else await c.query(`UPDATE stocktakes SET version=version+1 WHERE ws_id=$1 AND id=$2`, [ctx.wsId, stId]);
    return { lineId: input.lineId, version: r.rows[0].version as number };
  });
}

export async function setReason(ctx: Ctx, stId: string, input: z.infer<typeof zStocktakeReasonInput>) {
  return writeTx(ctx, async (c) => {
    await lockActive(c, ctx.wsId, stId);
    const r = await c.query(
      `UPDATE stocktake_lines SET reason_code=$4, reason_note=$5, version=version+1, updated_at=now()
       WHERE ws_id=$1 AND stocktake_id=$2 AND id=$3 AND version=$6 RETURNING version`,
      [ctx.wsId, stId, input.lineId, input.reasonCode, input.reasonNote, input.version],
    );
    if (r.rowCount === 0) fail('VERSION_CONFLICT', '他の端末でこの行が更新されています。再読み込みしてください。');
    return { lineId: input.lineId, version: r.rows[0].version as number };
  });
}

/** 理論在庫0で見つかったSKUを棚卸行に追加（同じSKUの行は重複生成しない） */
export async function addLine(ctx: Ctx, stId: string, skuId: string) {
  return writeTx(ctx, async (c) => {
    const st = await lockActive(c, ctx.wsId, stId);
    const s = await c.query(`SELECT archived FROM skus WHERE ws_id=$1 AND id=$2`, [ctx.wsId, skuId]);
    if (s.rowCount === 0) fail('NOT_FOUND', 'SKUが見つかりません');
    const ex = await c.query(`SELECT id, version FROM stocktake_lines WHERE ws_id=$1 AND stocktake_id=$2 AND sku_id=$3`, [ctx.wsId, stId, skuId]);
    if (ex.rowCount) return { lineId: ex.rows[0].id as string, version: ex.rows[0].version as number, existed: true };
    // 停止中なので残高は開始時から変わっていない
    const b = await c.query(`SELECT qty FROM balances WHERE ws_id=$1 AND sku_id=$2 AND location_id=$3`, [ctx.wsId, skuId, st.location_id]);
    const id = uuid();
    await c.query(
      `INSERT INTO stocktake_lines (ws_id,id,stocktake_id,sku_id,theoretical_qty,added_during_count) VALUES ($1,$2,$3,$4,$5,true)`,
      [ctx.wsId, id, stId, skuId, b.rows[0]?.qty ?? 0],
    );
    if (st.status === 'review') await c.query(`UPDATE stocktakes SET status='counting', version=version+1 WHERE ws_id=$1 AND id=$2`, [ctx.wsId, stId]);
    else await c.query(`UPDATE stocktakes SET version=version+1 WHERE ws_id=$1 AND id=$2`, [ctx.wsId, stId]);
    return { lineId: id, version: 1, existed: false };
  });
}

function validateLinesForReview(lines: { counted_qty: number | null; theoretical_qty: number; reason_code: string | null; reason_note: string }[]) {
  const uncounted = lines.filter((l) => l.counted_qty === null).length;
  if (uncounted) fail('VALIDATION', `未計数の行が${uncounted}件あります。数えていない商品を0個とはみなしません。0個なら0を入力してください。`, { uncounted });
}

/** 差異確認へ進む（全行計数済みが条件） */
export async function toReview(ctx: Ctx, stId: string, version: number) {
  return writeTx(ctx, async (c) => {
    const st = await lockActive(c, ctx.wsId, stId);
    if (st.version !== version) fail('VERSION_CONFLICT', '他の端末で棚卸が更新されています。再読み込みしてください。');
    const lines = (await c.query(`SELECT counted_qty, theoretical_qty, reason_code, reason_note FROM stocktake_lines WHERE ws_id=$1 AND stocktake_id=$2`, [ctx.wsId, stId]))
      .rows;
    validateLinesForReview(lines);
    const r = await c.query(`UPDATE stocktakes SET status='review', version=version+1 WHERE ws_id=$1 AND id=$2 RETURNING version`, [ctx.wsId, stId]);
    return { id: stId, version: r.rows[0].version as number };
  });
}

export async function confirmStocktake(ctx: Ctx, stId: string, cmd: z.infer<typeof zStocktakeConfirmCmd>) {
  return runCommand(ctx, 'stocktake_confirm', cmd.idempotencyKey, { stId, ...cmd }, async (c) => {
    const st = await lockActive(c, ctx.wsId, stId);
    if (st.status !== 'review') fail('STATE', '差異確認が済んでいません。差異を確認してから確定してください。');
    if (st.version !== cmd.version) fail('VERSION_CONFLICT', '差異確認の後に計数が変更されています。もう一度差異を確認してください。');
    const lines = (
      await c.query(
        `SELECT sl.id, sl.sku_id, sl.theoretical_qty, sl.counted_qty, sl.reason_code, sl.reason_note, s.code, s.name, s.color, s.size, s.unit
         FROM stocktake_lines sl JOIN skus s ON s.ws_id=sl.ws_id AND s.id=sl.sku_id WHERE sl.ws_id=$1 AND sl.stocktake_id=$2 ORDER BY s.code`,
        [ctx.wsId, stId],
      )
    ).rows;
    validateLinesForReview(lines);
    for (const l of lines) {
      const diff = Number(l.counted_qty) - Number(l.theoretical_qty);
      if (diff !== 0 && !l.reason_code) fail('VALIDATION', `差異のある行（${l.code}）に理由を選んでください`);
      if (diff !== 0 && l.reason_code === 'other' && !l.reason_note.trim()) fail('VALIDATION', `理由「その他」の行（${l.code}）にはメモを入力してください`);
    }
    const diffs = lines.filter((l) => Number(l.counted_qty) !== Number(l.theoretical_qty));

    const verifyBase = async () => {
      const loc = await c.query(`SELECT rev FROM locations WHERE ws_id=$1 AND id=$2`, [ctx.wsId, st.location_id]);
      const bal = await c.query(`SELECT sku_id, qty FROM balances WHERE ws_id=$1 AND location_id=$2`, [ctx.wsId, st.location_id]);
      const bm = new Map(bal.rows.map((b) => [b.sku_id as string, Number(b.qty)]));
      const mismatch = lines.filter((l) => (bm.get(l.sku_id) ?? 0) !== Number(l.theoretical_qty));
      const extra = bal.rows.filter((b) => Number(b.qty) > 0 && !lines.some((l) => l.sku_id === b.sku_id));
      if (Number(loc.rows[0].rev) !== Number(st.base_rev) || mismatch.length || extra.length) {
        fail('STATE', '棚卸開始後にこの場所の在庫が変更されています。古い理論在庫では調整できません。棚卸を中止して再棚卸してください。');
      }
    };

    let op = null;
    if (diffs.length) {
      op = await applyOperation(c, ctx, {
        kind: 'stocktake_adjust',
        businessDate: st.business_date,
        stocktakeId: stId,
        allowStocktakeId: stId,
        allowArchived: true,
        reason: `棚卸 ${st.st_no}`,
        movements: diffs.map((l) => ({
          skuId: l.sku_id,
          locationId: st.location_id,
          delta: Number(l.counted_qty) - Number(l.theoretical_qty),
          kind: 'stocktake_adjust' as const,
          reason: `${STOCKTAKE_REASONS[l.reason_code] ?? l.reason_code}${l.reason_note ? `：${l.reason_note}` : ''}`,
        })),
        check: async () => verifyBase(),
      });
    } else {
      await lockLocations(c, ctx.wsId, [st.location_id]);
      await verifyBase();
    }
    await c.query(`UPDATE stocktakes SET status='confirmed', confirmed_at=$3, version=version+1 WHERE ws_id=$1 AND id=$2`, [ctx.wsId, stId, ctx.now()]);
    await c.query(`UPDATE locations SET stocktake_id=NULL WHERE ws_id=$1 AND id=$2 AND stocktake_id=$3`, [ctx.wsId, st.location_id, stId]);
    const docId = uuid();
    const loc = (await c.query(`SELECT code, name FROM locations WHERE ws_id=$1 AND id=$2`, [ctx.wsId, st.location_id])).rows[0];
    await c.query(`INSERT INTO documents (ws_id,id,kind,ref_id,snapshot) VALUES ($1,$2,'stocktake_diff',$3,$4)`, [
      ctx.wsId,
      docId,
      stId,
      JSON.stringify({
        stNo: st.st_no,
        location: { code: loc.code, name: loc.name },
        businessDate: st.business_date,
        confirmedAt: ctx.now().toISOString(),
        opNo: op?.opNo ?? null,
        lines: lines.map((l) => ({
          code: l.code,
          name: l.name,
          color: l.color,
          size: l.size,
          unit: l.unit,
          theoretical: Number(l.theoretical_qty),
          counted: Number(l.counted_qty),
          diff: Number(l.counted_qty) - Number(l.theoretical_qty),
          reason: l.reason_code ? STOCKTAKE_REASONS[l.reason_code] : '',
          reasonNote: l.reason_note,
        })),
      }),
    ]);
    return { id: stId, adjusted: diffs.length, opNo: op?.opNo ?? null, operationId: op?.operationId ?? null, documentId: docId };
  });
}

export async function cancelStocktake(ctx: Ctx, stId: string, cmd: z.infer<typeof zStocktakeCancelCmd>) {
  return runCommand(ctx, 'stocktake_cancel', cmd.idempotencyKey, { stId, ...cmd }, async (c) => {
    const st = await lockActive(c, ctx.wsId, stId);
    await c.query(
      `UPDATE stocktakes SET status='cancelled', cancelled_at=$3, cancel_reason=$4, outside_movement_note=$5, version=version+1 WHERE ws_id=$1 AND id=$2`,
      [ctx.wsId, stId, ctx.now(), cmd.reason, cmd.outsideMovementNote],
    );
    await c.query(`UPDATE locations SET stocktake_id=NULL WHERE ws_id=$1 AND id=$2 AND stocktake_id=$3`, [ctx.wsId, st.location_id, stId]);
    return { id: stId };
  });
}

export async function getStocktake(ctx: Ctx, stId: string) {
  return readTx(ctx, async (c) => {
    const r = await c.query(
      `SELECT st.*, l.name location_name, l.code location_code FROM stocktakes st JOIN locations l ON l.ws_id=st.ws_id AND l.id=st.location_id WHERE st.ws_id=$1 AND st.id=$2`,
      [ctx.wsId, stId],
    );
    if (r.rowCount === 0) fail('NOT_FOUND', '棚卸が見つかりません');
    const lines = await c.query(
      `SELECT sl.*, s.code, s.name, s.color, s.size, s.unit, s.photo_file_id,
         (SELECT count(*) FROM stocktake_count_history h WHERE h.ws_id=sl.ws_id AND h.line_id=sl.id)::int AS count_edits
       FROM stocktake_lines sl JOIN skus s ON s.ws_id=sl.ws_id AND s.id=sl.sku_id WHERE sl.ws_id=$1 AND sl.stocktake_id=$2 ORDER BY s.code`,
      [ctx.wsId, stId],
    );
    const st = r.rows[0];
    const doc = await c.query(`SELECT id FROM documents WHERE ws_id=$1 AND kind='stocktake_diff' AND ref_id=$2 ORDER BY created_at DESC LIMIT 1`, [ctx.wsId, stId]);
    return {
      id: st.id,
      stNo: st.st_no,
      locationId: st.location_id,
      locationName: st.location_name,
      locationCode: st.location_code,
      status: st.status,
      businessDate: st.business_date,
      startedAt: st.started_at,
      confirmedAt: st.confirmed_at,
      cancelledAt: st.cancelled_at,
      cancelReason: st.cancel_reason,
      outsideMovementNote: st.outside_movement_note,
      version: st.version,
      documentId: doc.rows[0]?.id ?? null,
      lines: lines.rows.map((l) => ({
        id: l.id,
        skuId: l.sku_id,
        code: l.code,
        name: l.name,
        color: l.color,
        size: l.size,
        unit: l.unit,
        photoFileId: l.photo_file_id,
        theoretical: Number(l.theoretical_qty),
        counted: l.counted_qty === null ? null : Number(l.counted_qty),
        diff: l.counted_qty === null ? null : Number(l.counted_qty) - Number(l.theoretical_qty),
        reasonCode: l.reason_code,
        reasonNote: l.reason_note,
        addedDuringCount: l.added_during_count,
        countEdits: l.count_edits,
        version: l.version,
      })),
    };
  });
}

export async function listStocktakes(ctx: Ctx, opts: { active?: boolean; limit?: number; offset?: number } = {}) {
  return readTx(ctx, async (c) => {
    const r = await c.query(
      `SELECT st.id, st.st_no, st.status, st.business_date, st.started_at, st.confirmed_at, st.cancelled_at, l.name location_name, st.location_id,
         (SELECT count(*) FROM stocktake_lines x WHERE x.ws_id=st.ws_id AND x.stocktake_id=st.id)::int lines,
         (SELECT count(*) FROM stocktake_lines x WHERE x.ws_id=st.ws_id AND x.stocktake_id=st.id AND x.counted_qty IS NULL)::int uncounted
       FROM stocktakes st JOIN locations l ON l.ws_id=st.ws_id AND l.id=st.location_id
       WHERE st.ws_id=$1 ${opts.active ? `AND st.status IN ('counting','review')` : ''}
       ORDER BY st.started_at DESC LIMIT $2 OFFSET $3`,
      [ctx.wsId, Math.min(opts.limit ?? 50, 200), opts.offset ?? 0],
    );
    return r.rows.map((x) => ({
      id: x.id,
      stNo: x.st_no,
      status: x.status,
      businessDate: x.business_date,
      startedAt: x.started_at,
      confirmedAt: x.confirmed_at,
      cancelledAt: x.cancelled_at,
      locationName: x.location_name,
      locationId: x.location_id,
      lines: x.lines,
      uncounted: x.uncounted,
    }));
  });
}
