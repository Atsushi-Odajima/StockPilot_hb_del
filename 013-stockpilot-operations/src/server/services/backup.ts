// 全データのエクスポートと全体復元（OPERATIONS.md §バックアップ・復元）
// ・エクスポート：REPEATABLE READ の一貫したスナップショットから業務データを取得し、添付は変更不可の実体を同梱する。
// ・復元：別データ世代（staging ワークスペース）へ展開 → 検証 → 利用者確認 → tenants.active_ws_id を原子的に切替。
//   切替でデータ世代（dataEpoch = ワークスペースID）が変わり、旧端末の未送信確定要求は拒否される。
import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import yauzl from 'yauzl';
import type { Tx } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { fail } from '../errors.js';
import { type Ctx, uuid, sha256 } from './context.js';
import { latestSchemaVersion } from '../db/migrate.js';
import { BACKUP_MAX_BYTES, BACKUP_MAX_FILES } from '../../shared/limits.js';

export const APP_VERSION = '0.1.0';
const FORMAT = 'stockpilot-backup';

// 復元対象テーブルと列（許可リスト）。ws_id は常に復元先に置き換える。
const TABLES: { name: string; cols: string[]; order: string }[] = [
  { name: 'files', cols: ['id', 'sha256', 'size', 'mime', 'created_at'], order: 'created_at, id' },
  { name: 'suppliers', cols: ['id', 'code', 'code_key', 'name', 'contact_name', 'contact', 'lead_time_days', 'note', 'archived', 'version', 'created_at', 'updated_at'], order: 'code_key' },
  { name: 'locations', cols: ['id', 'code', 'code_key', 'name', 'description', 'kind', 'archived', 'stocktake_id', 'rev', 'version', 'created_at', 'updated_at'], order: 'code_key' },
  {
    name: 'skus',
    cols: ['id', 'code', 'code_key', 'name', 'group_name', 'color', 'size', 'attrs', 'category', 'brand', 'unit', 'supplier_id', 'memo', 'photo_file_id', 'archived', 'safety_stock', 'reorder_point', 'target_stock', 'min_order_qty', 'order_multiple', 'lead_time_days', 'version', 'created_at', 'updated_at'],
    order: 'code_key',
  },
  { name: 'sku_codes', cols: ['id', 'sku_id', 'code', 'kind', 'created_at'], order: 'created_at, id' },
  {
    name: 'purchase_orders',
    cols: ['id', 'po_no', 'supplier_id', 'status', 'created_date', 'ordered_date', 'due_date', 'location_id', 'external_ref', 'supplier_note', 'internal_memo', 'replaces_po_id', 'source_key', 'version', 'created_at', 'updated_at'],
    order: 'created_at, id',
  },
  { name: 'po_lines', cols: ['id', 'po_id', 'line_no', 'sku_id', 'qty', 'received_qty', 'cancelled_qty', 'due_date', 'location_id', 'basis_p', 'sku_snapshot', 'created_at'], order: 'po_id, line_no' },
  { name: 'po_revisions', cols: ['id', 'po_id', 'version', 'action', 'reason', 'snapshot', 'created_at'], order: 'created_at, id' },
  {
    name: 'stocktakes',
    cols: ['id', 'st_no', 'location_id', 'status', 'base_rev', 'started_at', 'business_date', 'confirmed_at', 'cancelled_at', 'cancel_reason', 'outside_movement_note', 'version'],
    order: 'started_at, id',
  },
  { name: 'stocktake_lines', cols: ['id', 'stocktake_id', 'sku_id', 'theoretical_qty', 'counted_qty', 'reason_code', 'reason_note', 'added_during_count', 'version', 'updated_at'], order: 'stocktake_id, id' },
  { name: 'stocktake_count_history', cols: ['id', 'line_id', 'counted_qty', 'counted_at'], order: 'counted_at, id' },
  {
    name: 'import_batches',
    cols: ['id', 'kind', 'file_hash', 'file_name', 'encoding', 'mapping', 'status', 'row_count', 'excluded_rows', 'result', 'created_at', 'committed_at'],
    order: 'created_at, id',
  },
  {
    name: 'operations',
    cols: ['id', 'op_no', 'kind', 'purpose', 'business_date', 'committed_at', 'po_id', 'stocktake_id', 'import_id', 'reason', 'note', 'external_ref', 'destination_label', 'no_source', 'external_id', 'external_hash'],
    order: 'committed_at, op_no',
  },
  {
    name: 'ledger_events',
    cols: ['id', 'op_id', 'line_no', 'kind', 'sku_id', 'location_id', 'qty', 'business_date', 'committed_at', 'actor_user_id', 'po_line_id', 'source_event_id', 'reversal_of_event_id', 'transfer_pair_line', 'reason', 'sku_snapshot', 'location_snapshot'],
    order: 'seq',
  },
  { name: 'balances', cols: ['sku_id', 'location_id', 'qty', 'last_in_date', 'last_out_date', 'updated_at'], order: 'sku_id, location_id' },
  { name: 'documents', cols: ['id', 'kind', 'ref_id', 'snapshot', 'created_at'], order: 'created_at, id' },
];

export interface Manifest {
  format: string;
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  tenantName: string;
  counters: { op_seq: number; po_seq: number; st_seq: number };
  counts: Record<string, number>;
  data: { path: string; size: number; sha256: string }[];
  files: { path: string; size: number; sha256: string }[];
}

/** 全データを ZIP に書き出し、一時ファイルのパスを返す */
export async function exportBackup(ctx: Ctx): Promise<{ filePath: string; manifest: Manifest }> {
  const snapshot = await withTx(
    ctx.db,
    async (c) => {
      const t = await c.query(`SELECT t.name, t.active_ws_id, t.sample_ws_id FROM tenants t WHERE t.id=$1`, [ctx.tenantId]);
      const expected = ctx.mode === 'sample' ? t.rows[0].sample_ws_id : t.rows[0].active_ws_id;
      if (expected !== ctx.wsId) fail('EPOCH_MISMATCH', 'データ世代が変わりました。再読み込みしてください。');
      const w = await c.query(`SELECT op_seq, po_seq, st_seq FROM workspaces WHERE id=$1`, [ctx.wsId]);
      const data: Record<string, unknown[]> = {};
      for (const tb of TABLES) {
        const r = await c.query(`SELECT ${tb.cols.join(',')} FROM ${tb.name} WHERE ws_id=$1 ORDER BY ${tb.order}`, [ctx.wsId]);
        data[tb.name] = r.rows;
      }
      return { tenantName: t.rows[0].name as string, counters: w.rows[0], data };
    },
    { isolation: 'REPEATABLE READ', readOnly: true },
  );
  const zip = new yazl.ZipFile();
  const manifest: Manifest = {
    format: FORMAT,
    schemaVersion: latestSchemaVersion(),
    appVersion: APP_VERSION,
    createdAt: ctx.now().toISOString(),
    tenantName: snapshot.tenantName,
    counters: snapshot.counters,
    counts: {},
    data: [],
    files: [],
  };
  for (const tb of TABLES) {
    const buf = Buffer.from(JSON.stringify(snapshot.data[tb.name]));
    manifest.counts[tb.name] = snapshot.data[tb.name].length;
    manifest.data.push({ path: `data/${tb.name}.json`, size: buf.length, sha256: sha256(buf) });
    zip.addBuffer(buf, `data/${tb.name}.json`);
  }
  for (const f of snapshot.data.files as { sha256: string }[]) {
    if (manifest.files.some((x) => x.sha256 === f.sha256)) continue;
    const b = await ctx.storage.get(f.sha256);
    if (!b || sha256(b) !== f.sha256) fail('INTERNAL', '添付ファイルの実体が見つからないため、バックアップを作成できませんでした（作成失敗）');
    manifest.files.push({ path: `files/${f.sha256}`, size: b!.length, sha256: f.sha256 });
    zip.addBuffer(b!, `files/${f.sha256}`);
  }
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');
  const filePath = path.join(ctx.storage.tmpDir(), `backup-${uuid()}.zip`);
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(filePath, { mode: 0o600 });
    zip.outputStream.pipe(out).on('close', () => resolve()).on('error', reject);
    zip.end();
  });
  // 成功した場合だけ最終バックアップ日時を記録
  await ctx.db.query(`INSERT INTO audit_log (tenant_id, ws_id, actor_user_id, action, detail, ok) VALUES ($1,$2,$3,'backup.export',$4,true)`, [
    ctx.tenantId,
    ctx.wsId,
    ctx.userId,
    JSON.stringify({ counts: manifest.counts, files: manifest.files.length }),
  ]);
  return { filePath, manifest };
}

// ---------- ZIP 読み込み（安全検査付き） ----------
const ENTRY_RE = /^(manifest\.json|data\/[a-z_]+\.json|files\/[0-9a-f]{64})$/;

async function readZip(zipPath: string): Promise<Map<string, Buffer>> {
  const stat = fs.statSync(zipPath);
  if (stat.size > BACKUP_MAX_BYTES) fail('TOO_LARGE', 'バックアップファイルが大きすぎます');
  const zf: yauzl.ZipFile = await new Promise((res, rej) =>
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (e, z) => (e ? rej(e) : res(z!))),
  ).catch(() => fail('RESTORE_INVALID', 'ZIPファイルとして読めません')) as yauzl.ZipFile;
  const out = new Map<string, Buffer>();
  let total = 0;
  let count = 0;
  await new Promise<void>((resolve, reject) => {
    zf.on('error', reject);
    zf.on('end', () => resolve());
    zf.on('entry', (entry: yauzl.Entry) => {
      count++;
      const name = entry.fileName;
      if (count > BACKUP_MAX_FILES + 20) return reject(new Error('ファイル数が多すぎます'));
      if (!ENTRY_RE.test(name) || name.includes('..') || path.isAbsolute(name)) return reject(new Error(`想定外のファイル名: ${name.slice(0, 80)}`));
      if (out.has(name)) return reject(new Error(`重複したファイル: ${name}`));
      total += entry.uncompressedSize;
      if (total > BACKUP_MAX_BYTES) return reject(new Error('展開後の容量が上限を超えます'));
      zf.openReadStream(entry, (err, rs) => {
        if (err || !rs) return reject(err ?? new Error('read error'));
        const chunks: Buffer[] = [];
        let got = 0;
        rs.on('data', (c: Buffer) => {
          got += c.length;
          if (got > entry.uncompressedSize) {
            rs.destroy();
            reject(new Error('展開サイズが申告と一致しません'));
          }
          chunks.push(c);
        });
        rs.on('error', reject);
        rs.on('end', () => {
          out.set(name, Buffer.concat(chunks));
          zf.readEntry();
        });
      });
    });
    zf.readEntry();
  }).catch((e) => fail('RESTORE_INVALID', `バックアップの展開を中止しました：${(e as Error).message}`));
  zf.close();
  return out;
}

export interface RestorePreview {
  stagingId: string;
  manifest: Pick<Manifest, 'schemaVersion' | 'appVersion' | 'createdAt' | 'tenantName' | 'counts'>;
  current: Record<string, number>;
  activeStocktakes: number;
  warnings: string[];
}

/** 復元の準備：別世代へ展開して検証する。現在のデータは変更しない。 */
export async function stageRestore(ctx: Ctx, zipPath: string): Promise<RestorePreview> {
  if (ctx.mode !== 'live') fail('STATE', 'サンプル表示中は復元できません。本番表示に切り替えてください。');
  const entries = await readZip(zipPath);
  const mbuf = entries.get('manifest.json');
  if (!mbuf) fail('RESTORE_INVALID', 'manifest.json がありません');
  let manifest: Manifest;
  try {
    manifest = JSON.parse(mbuf!.toString('utf8'));
  } catch {
    return fail('RESTORE_INVALID', 'manifest.json を読めません');
  }
  if (manifest.format !== FORMAT) fail('RESTORE_INVALID', 'StockPilot のバックアップではありません');
  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion > latestSchemaVersion()) {
    fail('RESTORE_INVALID', `このバックアップは新しい版（スキーマ${manifest.schemaVersion}）で作成されています。アプリを更新してから復元してください。`);
  }
  if (manifest.schemaVersion < 1) fail('RESTORE_INVALID', '対応していないバックアップ形式です');
  // データファイルのハッシュ検査
  const tableData: Record<string, Record<string, unknown>[]> = {};
  for (const tb of TABLES) {
    const p = `data/${tb.name}.json`;
    const m = manifest.data?.find((d) => d.path === p);
    const b = entries.get(p);
    if (!m || !b) fail('RESTORE_INVALID', `${p} が欠けています`);
    if (sha256(b!) !== m!.sha256 || b!.length !== m!.size) fail('RESTORE_INVALID', `${p} のハッシュが一致しません（破損または改変）`);
    try {
      const arr = JSON.parse(b!.toString('utf8'));
      if (!Array.isArray(arr)) throw new Error();
      tableData[tb.name] = arr;
    } catch {
      fail('RESTORE_INVALID', `${p} を読めません`);
    }
    if (tableData[tb.name].length !== manifest.counts?.[tb.name]) fail('RESTORE_INVALID', `${p} の件数がマニフェストと一致しません`);
  }
  // 添付：参照される全実体があり、ハッシュが一致すること
  for (const f of tableData.files as { sha256: string; size: number }[]) {
    const b = entries.get(`files/${f.sha256}`);
    if (!b) fail('RESTORE_INVALID', `添付ファイル ${String(f.sha256).slice(0, 12)}… が欠けています`);
    if (sha256(b!) !== f.sha256 || b!.length !== f.size) fail('RESTORE_INVALID', `添付ファイル ${String(f.sha256).slice(0, 12)}… のハッシュが一致しません`);
  }
  for (const f of tableData.files as { sha256: string }[]) await ctx.storage.put(entries.get(`files/${f.sha256}`)!);

  const stagingId = uuid();
  const preview = await withTx(ctx.db, async (c) => {
    const t = await c.query(`SELECT active_ws_id FROM tenants WHERE id=$1 FOR SHARE`, [ctx.tenantId]);
    if (t.rows[0].active_ws_id !== ctx.wsId) fail('EPOCH_MISMATCH', 'データ世代が変わりました。再読み込みしてください。');
    // 古い staging は破棄
    await c.query(`DELETE FROM workspaces WHERE tenant_id=$1 AND kind='staging'`, [ctx.tenantId]);
    // 復元先は認証中の事業者に結び直す（バックアップ内の事業者ID等は使わない）
    const ct = manifest.counters ?? { op_seq: 0, po_seq: 0, st_seq: 0 };
    for (const v of [ct.op_seq, ct.po_seq, ct.st_seq]) if (!Number.isSafeInteger(v) || v < 0) fail('RESTORE_INVALID', '採番情報が不正です');
    await c.query(`INSERT INTO workspaces (id, tenant_id, kind, label, op_seq, po_seq, st_seq) VALUES ($1,$2,'staging',$3,$4,$5,$6)`, [
      stagingId,
      ctx.tenantId,
      `復元 ${manifest.createdAt?.slice(0, 19) ?? ''}`,
      ct.op_seq,
      ct.po_seq,
      ct.st_seq,
    ]);
    await insertTables(c, stagingId, tableData);
    await validateStaging(c, stagingId);
    const cur: Record<string, number> = {};
    for (const tb of ['skus', 'locations', 'suppliers', 'purchase_orders', 'ledger_events', 'stocktakes', 'files']) {
      cur[tb] = Number((await c.query(`SELECT count(*)::int n FROM ${tb} WHERE ws_id=$1`, [ctx.wsId])).rows[0].n);
    }
    const active = Number((await c.query(`SELECT count(*)::int n FROM stocktakes WHERE ws_id=$1 AND status IN ('counting','review')`, [stagingId])).rows[0].n);
    return { cur, active };
  }).catch((e) => {
    if ((e as { code?: string }).code && /^[0-9A-Z]{5}$/.test((e as { code: string }).code)) {
      fail('RESTORE_INVALID', `バックアップの内容が整合しません（参照切れ・重複・制約違反）：${(e as Error).message.slice(0, 200)}`);
    }
    throw e;
  });
  const warnings: string[] = [];
  if (preview.active) warnings.push(`棚卸中（停止中）の場所が${preview.active}件あります。復元後に再計数するか、明示的に中止してください。`);
  return {
    stagingId,
    manifest: { schemaVersion: manifest.schemaVersion, appVersion: manifest.appVersion, createdAt: manifest.createdAt, tenantName: manifest.tenantName, counts: manifest.counts },
    current: preview.cur,
    activeStocktakes: preview.active,
    warnings,
  };
}

async function insertTables(c: Tx, wsId: string, data: Record<string, Record<string, unknown>[]>) {
  for (const tb of TABLES) {
    let rows = data[tb.name];
    if (!rows.length) continue;
    for (const r of rows) {
      if (typeof r !== 'object' || r === null || Array.isArray(r)) fail('RESTORE_INVALID', `${tb.name} の行形式が不正です`);
      for (const k of Object.keys(r)) if (!tb.cols.includes(k)) fail('RESTORE_INVALID', `${tb.name} に想定外の列 ${k.slice(0, 40)} があります`);
    }
    let deferredReplaces: { id: unknown; replaces: unknown }[] = [];
    if (tb.name === 'purchase_orders') {
      deferredReplaces = rows.filter((r) => r.replaces_po_id).map((r) => ({ id: r.id, replaces: r.replaces_po_id }));
      rows = rows.map((r) => ({ ...r, replaces_po_id: null }));
    }
    // 1000行ずつ json_populate_recordset で投入（列は許可リストのみ、ws_id は復元先で上書き）
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      await c.query(
        `INSERT INTO ${tb.name} (ws_id, ${tb.cols.join(',')}) SELECT $1, ${tb.cols.join(',')} FROM json_populate_recordset(NULL::${tb.name}, $2::json)`,
        [wsId, JSON.stringify(chunk)],
      );
    }
    for (const d of deferredReplaces) await c.query(`UPDATE purchase_orders SET replaces_po_id=$3 WHERE ws_id=$1 AND id=$2`, [wsId, d.id, d.replaces]);
  }
}

/** 台帳と残高、発注残、棚卸状態の整合性を検査 */
export async function validateStaging(c: Tx, wsId: string) {
  const bal = await c.query(
    `WITH led AS (SELECT sku_id, location_id, sum(qty)::bigint q FROM ledger_events WHERE ws_id=$1 GROUP BY 1,2)
     SELECT count(*)::int n FROM (SELECT * FROM balances WHERE ws_id=$1) b FULL OUTER JOIN led ON led.sku_id=b.sku_id AND led.location_id=b.location_id
     WHERE coalesce(b.qty,0) <> coalesce(led.q,0)`,
    [wsId],
  );
  if (bal.rows[0].n > 0) fail('RESTORE_INVALID', `台帳と残高が一致しない行が${bal.rows[0].n}件あります`);
  const po = await c.query(
    `SELECT count(*)::int n FROM po_lines pl WHERE pl.ws_id=$1 AND pl.received_qty <> coalesce((SELECT sum(qty) FROM ledger_events e WHERE e.ws_id=pl.ws_id AND e.po_line_id=pl.id),0)`,
    [wsId],
  );
  if (po.rows[0].n > 0) fail('RESTORE_INVALID', `発注の受領数と台帳が一致しない明細が${po.rows[0].n}件あります`);
  const st = await c.query(
    `SELECT count(*)::int n FROM locations l WHERE l.ws_id=$1 AND (
       (l.stocktake_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stocktakes s WHERE s.ws_id=l.ws_id AND s.id=l.stocktake_id AND s.status IN ('counting','review') AND s.location_id=l.id))
       OR (l.stocktake_id IS NULL AND EXISTS (SELECT 1 FROM stocktakes s WHERE s.ws_id=l.ws_id AND s.location_id=l.id AND s.status IN ('counting','review'))))`,
    [wsId],
  );
  if (st.rows[0].n > 0) fail('RESTORE_INVALID', '棚卸の停止状態と棚卸セッションが一致しません');
  const neg = await c.query(`SELECT count(*)::int n FROM ledger_events e JOIN operations o ON o.ws_id=e.ws_id AND o.id=e.op_id WHERE e.ws_id=$1 AND e.business_date IS NULL`, [wsId]);
  if (neg.rows[0].n > 0) fail('RESTORE_INVALID', '台帳の日付が欠けています');
}

/** 利用者確認後：アクティブ世代を原子的に切り替える（旧世代は退避して戻せる） */
export async function commitRestore(ctx: Ctx, stagingId: string) {
  return withTx(ctx.db, async (c) => {
    const t = await c.query(`SELECT active_ws_id FROM tenants WHERE id=$1 FOR UPDATE`, [ctx.tenantId]);
    if (t.rows[0].active_ws_id !== ctx.wsId) fail('EPOCH_MISMATCH', 'データ世代が変わりました。再読み込みしてください。');
    const s = await c.query(`SELECT kind FROM workspaces WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [stagingId, ctx.tenantId]);
    if (s.rowCount === 0 || s.rows[0].kind !== 'staging') fail('NOT_FOUND', '復元の準備データが見つかりません。もう一度ファイルを選んでください。');
    await validateStaging(c, stagingId);
    // 以前の退避世代は削除し、今回の現在世代を退避
    const prev = await c.query(`SELECT previous_ws_id FROM tenants WHERE id=$1`, [ctx.tenantId]);
    await c.query(`UPDATE workspaces SET kind='retired', label=$2 WHERE id=$1`, [ctx.wsId, `復元前の退避 ${ctx.now().toISOString().slice(0, 19)}`]);
    await c.query(`UPDATE workspaces SET kind='live' WHERE id=$1`, [stagingId]);
    await c.query(`UPDATE tenants SET active_ws_id=$2, previous_ws_id=$3 WHERE id=$1`, [ctx.tenantId, stagingId, ctx.wsId]);
    if (prev.rows[0].previous_ws_id && prev.rows[0].previous_ws_id !== ctx.wsId) {
      await c.query(`DELETE FROM workspaces WHERE id=$1 AND tenant_id=$2 AND kind='retired'`, [prev.rows[0].previous_ws_id, ctx.tenantId]);
    }
    await c.query(`INSERT INTO audit_log (tenant_id, ws_id, actor_user_id, action, detail, ok) VALUES ($1,$2,$3,'backup.restore',$4,true)`, [
      ctx.tenantId,
      stagingId,
      ctx.userId,
      JSON.stringify({ from: ctx.wsId }),
    ]);
    return { dataEpoch: stagingId, previousEpoch: ctx.wsId };
  });
}

/** 直前の復元を取り消し、退避した世代へ戻す */
export async function rollbackRestore(ctx: Ctx) {
  return withTx(ctx.db, async (c) => {
    const t = await c.query(`SELECT active_ws_id, previous_ws_id FROM tenants WHERE id=$1 FOR UPDATE`, [ctx.tenantId]);
    if (t.rows[0].active_ws_id !== ctx.wsId) fail('EPOCH_MISMATCH', 'データ世代が変わりました。再読み込みしてください。');
    const prev = t.rows[0].previous_ws_id;
    if (!prev) fail('STATE', '戻せる退避データがありません');
    const w = await c.query(`SELECT kind FROM workspaces WHERE id=$1 AND tenant_id=$2`, [prev, ctx.tenantId]);
    if (w.rowCount === 0 || w.rows[0].kind !== 'retired') fail('STATE', '戻せる退避データがありません');
    await c.query(`UPDATE workspaces SET kind='retired' WHERE id=$1`, [ctx.wsId]);
    await c.query(`UPDATE workspaces SET kind='live' WHERE id=$1`, [prev]);
    await c.query(`UPDATE tenants SET active_ws_id=$2, previous_ws_id=$3 WHERE id=$1`, [ctx.tenantId, prev, ctx.wsId]);
    await c.query(`INSERT INTO audit_log (tenant_id, ws_id, actor_user_id, action, ok) VALUES ($1,$2,$3,'backup.rollback',true)`, [ctx.tenantId, prev, ctx.userId]);
    return { dataEpoch: prev };
  });
}

export async function discardStaging(ctx: Ctx, stagingId: string) {
  await ctx.db.query(`DELETE FROM workspaces WHERE id=$1 AND tenant_id=$2 AND kind='staging'`, [stagingId, ctx.tenantId]);
  return { id: stagingId };
}

export async function backupStatus(ctx: Ctx) {
  const r = await ctx.db.query(
    `SELECT max(created_at) FILTER (WHERE action='backup.export' AND ok) last_backup, max(created_at) FILTER (WHERE action='backup.restore' AND ok) last_restore
     FROM audit_log WHERE tenant_id=$1`,
    [ctx.tenantId],
  );
  const t = await ctx.db.query(`SELECT previous_ws_id FROM tenants WHERE id=$1`, [ctx.tenantId]);
  return { lastBackupAt: r.rows[0].last_backup, lastRestoreAt: r.rows[0].last_restore, canRollback: !!t.rows[0].previous_ws_id };
}
