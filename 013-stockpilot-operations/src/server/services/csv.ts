// CSV 取込・出力（INVENTORY_RULES.md §CSV）
// 取込：ファイル選択 → 文字コード・列割当 → プレビュー（本番不変）→ 検証 → 除外指定 → 確定（全件原子的）
import Papa from 'papaparse';
import type { Tx } from '../db/pool.js';
import { fail } from '../errors.js';
import { type Ctx, readTx, runCommand, uuid, sha256, writeTx, stableStringify } from './context.js';
import { codeKey, validateBarcode } from '../../shared/codes.js';
import { CSV_MAX_BYTES, CSV_MAX_MASTER_ROWS, CSV_MAX_QTY_ROWS, MAX_LINES_PER_OP, parseStrictInt, MAX_OP_QTY, MAX_BALANCE } from '../../shared/limits.js';
import { isValidDate } from '../../shared/dates.js';
import { validateReplenishSettings } from '../../domain/replenish.js';
import { insertSku, insertSkuCode, insertLocation, insertSupplier } from './masters.js';
import { initialStockTx, outsideReceiptTx, issueTx, transferTx, correctionTx, applyOperation } from './inventory.js';
import { createDraftTx } from './po.js';

export type ImportKind = 'skus' | 'locations' | 'suppliers' | 'initial_stock' | 'po_drafts' | 'movements';
export const IMPORT_KINDS: ImportKind[] = ['skus', 'locations', 'suppliers', 'initial_stock', 'po_drafts', 'movements'];

interface FieldDef {
  key: string;
  label: string;
  required?: boolean;
  aliases?: string[];
}

export const FIELDS: Record<ImportKind, FieldDef[]> = {
  skus: [
    { key: 'code', label: 'SKUコード', required: true, aliases: ['sku', 'sku_code'] },
    { key: 'name', label: '商品名', required: true, aliases: ['name'] },
    { key: 'group', label: '商品グループ' },
    { key: 'color', label: '色' },
    { key: 'size', label: 'サイズ' },
    { key: 'attrs', label: 'その他属性' },
    { key: 'category', label: 'カテゴリ' },
    { key: 'brand', label: 'ブランド' },
    { key: 'unit', label: '単位' },
    { key: 'supplier_code', label: '標準仕入先コード' },
    { key: 'memo', label: '内部メモ' },
    { key: 'safety_stock', label: '安全在庫' },
    { key: 'reorder_point', label: '発注点' },
    { key: 'target_stock', label: '目標在庫' },
    { key: 'min_order_qty', label: '最小発注数量' },
    { key: 'order_multiple', label: '発注単位' },
    { key: 'lead_time_days', label: 'リードタイム日数' },
    { key: 'jan', label: 'JAN', aliases: ['JAN/EAN', 'jan_code', 'EAN'] },
  ],
  locations: [
    { key: 'code', label: '場所コード', required: true },
    { key: 'name', label: '場所名', required: true },
    { key: 'kind', label: '種類', required: true },
    { key: 'description', label: '説明' },
  ],
  suppliers: [
    { key: 'code', label: '仕入先コード', required: true },
    { key: 'name', label: '仕入先名', required: true },
    { key: 'contact_name', label: '担当者' },
    { key: 'contact', label: '連絡先' },
    { key: 'lead_time_days', label: 'リードタイム日数' },
    { key: 'note', label: '備考' },
  ],
  initial_stock: [
    { key: 'sku_code', label: 'SKUコード', required: true },
    { key: 'location_code', label: '場所コード', required: true },
    { key: 'qty', label: '数量', required: true },
  ],
  po_drafts: [
    { key: 'supplier_code', label: '仕入先コード', required: true },
    { key: 'sku_code', label: 'SKUコード', required: true },
    { key: 'qty', label: '数量', required: true },
    { key: 'location_code', label: '納入場所コード', required: true },
    { key: 'due_date', label: '希望納期' },
    { key: 'group', label: '発注グループ' },
  ],
  movements: [
    { key: 'external_id', label: '外部ID' },
    { key: 'type', label: '種別', required: true },
    { key: 'date', label: '日付', required: true },
    { key: 'sku_code', label: 'SKUコード', required: true },
    { key: 'location_code', label: '場所コード', required: true },
    { key: 'to_location_code', label: '移動先場所コード' },
    { key: 'qty', label: '数量', required: true },
    { key: 'purpose', label: '目的' },
    { key: 'reason', label: '理由' },
    { key: 'ref', label: '参照番号' },
  ],
};

const MOVEMENT_TYPES: Record<string, 'outside_receipt' | 'issue' | 'transfer' | 'correction_increase' | 'correction_decrease' | 'disposal'> = {
  発注外入庫: 'outside_receipt',
  outside_receipt: 'outside_receipt',
  出庫: 'issue',
  issue: 'issue',
  場所移動: 'transfer',
  移動: 'transfer',
  transfer: 'transfer',
  数量訂正増: 'correction_increase',
  correction_increase: 'correction_increase',
  数量訂正減: 'correction_decrease',
  correction_decrease: 'correction_decrease',
  廃棄: 'disposal',
  disposal: 'disposal',
};
const PURPOSES: Record<string, 'sale' | 'sample' | 'business_use' | 'other'> = {
  販売: 'sale',
  sale: 'sale',
  サンプル配布: 'sample',
  sample: 'sample',
  業務使用: 'business_use',
  business_use: 'business_use',
  その他: 'other',
  other: 'other',
};

export function templateCsv(kind: ImportKind): string {
  return '﻿' + FIELDS[kind].map((f) => csvCell(f.label)).join(',') + '\r\n';
}

// ---------- 解析 ----------
export function decodeCsv(buf: Buffer, encoding: 'utf-8' | 'shift_jis'): string {
  if (buf.length > CSV_MAX_BYTES) fail('TOO_LARGE', `CSVは${CSV_MAX_BYTES / 1024 / 1024}MBまでです。ファイルを分割してください。`);
  try {
    if (encoding === 'shift_jis') return new TextDecoder('shift_jis', { fatal: true }).decode(buf);
    let text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  } catch {
    fail('VALIDATION', `文字コード（${encoding === 'shift_jis' ? 'Shift_JIS' : 'UTF-8'}）として読めません。文字コードの選択を確認してください。`);
  }
  return '';
}

export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const res = Papa.parse<string[]>(text, { header: false, skipEmptyLines: 'greedy', delimiter: ',' });
  const fatal = res.errors.find((e) => e.type === 'Quotes');
  if (fatal) fail('VALIDATION', `CSVの引用符が閉じていません（${fatal.row !== undefined ? fatal.row + 1 + '行目付近' : ''}）`);
  const all = res.data;
  if (all.length === 0) fail('VALIDATION', 'CSVが空です');
  const header = all[0].map((h) => h.trim());
  const seen = new Set<string>();
  for (const h of header) {
    if (!h) continue;
    if (seen.has(h)) fail('VALIDATION', `見出し「${h}」が重複しています`);
    seen.add(h);
  }
  return { header, rows: all.slice(1) };
}

export function autoMapping(kind: ImportKind, header: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const f of FIELDS[kind]) {
    const names = [f.label, f.key, ...(f.aliases ?? [])].map((x) => x.toLowerCase());
    const idx = header.findIndex((h) => names.includes(h.toLowerCase()));
    if (idx >= 0) m[f.key] = idx;
  }
  return m;
}

interface RowResult {
  rowNo: number; // 元ファイルの行番号（見出し=1行目）
  values: Record<string, string>;
  errors: string[];
  action?: string; // create / skip_same / import
}

const cell = (row: string[], mapping: Record<string, number>, key: string) => {
  const i = mapping[key];
  return i === undefined ? '' : (row[i] ?? '');
};

// ---------- 検証（プレビューと確定で同じ関数を使う） ----------
async function analyze(c: Tx, ctx: Ctx, kind: ImportKind, rows: string[][], mapping: Record<string, number>) {
  const fields = FIELDS[kind];
  for (const f of fields) if (f.required && mapping[f.key] === undefined) fail('VALIDATION', `必須列「${f.label}」が割り当てられていません`);
  const results: RowResult[] = rows.map((r, i) => {
    const values: Record<string, string> = {};
    for (const f of fields) values[f.key] = cell(r, mapping, f.key);
    const errors: string[] = [];
    for (const f of fields) if (f.required && !values[f.key].trim()) errors.push(`${f.label}が空です`);
    return { rowNo: i + 2, values, errors };
  });
  const skuByKey = async (keys: string[]) => {
    const r = await c.query(`SELECT id, code, code_key, archived FROM skus WHERE ws_id=$1 AND code_key = ANY($2::text[])`, [ctx.wsId, [...new Set(keys)]]);
    return new Map(r.rows.map((x) => [x.code_key as string, x]));
  };
  const locByKey = async (keys: string[]) => {
    const r = await c.query(`SELECT id, code, code_key, name, kind, archived, stocktake_id FROM locations WHERE ws_id=$1 AND code_key = ANY($2::text[])`, [
      ctx.wsId,
      [...new Set(keys)],
    ]);
    return new Map(r.rows.map((x) => [x.code_key as string, x]));
  };
  const supByKey = async (keys: string[]) => {
    const r = await c.query(`SELECT id, code, code_key, name, contact_name, contact, lead_time_days, note, archived FROM suppliers WHERE ws_id=$1 AND code_key = ANY($2::text[])`, [
      ctx.wsId,
      [...new Set(keys)],
    ]);
    return new Map(r.rows.map((x) => [x.code_key as string, x]));
  };
  const intField = (res: RowResult, key: string, label: string, min: number, max: number, required = false) => {
    const v = res.values[key].trim();
    if (!v) {
      if (required) res.errors.push(`${label}が空です`);
      return null;
    }
    const n = parseStrictInt(v);
    if (n === null || n < min || n > max) {
      res.errors.push(`${label}「${v}」は${min}〜${max.toLocaleString()}の整数で入力してください`);
      return null;
    }
    return n;
  };
  const dupCheck = (key: string, label: string) => {
    const seen = new Map<string, number>();
    for (const r of results) {
      const k = codeKey(r.values[key]);
      if (!k) continue;
      if (seen.has(k)) r.errors.push(`${label}「${r.values[key]}」がファイル内の${seen.get(k)}行目と重複しています（大小文字・前後空白の違いは同一扱い）`);
      else seen.set(k, r.rowNo);
    }
  };

  const summary: Record<string, unknown> = {};

  if (kind === 'skus') {
    dupCheck('code', 'SKUコード');
    const existing = await skuByKey(results.map((r) => codeKey(r.values.code)));
    const sups = await supByKey(results.map((r) => codeKey(r.values.supplier_code)).filter(Boolean));
    const jans = results.map((r) => r.values.jan.trim()).filter(Boolean);
    const janOwners = jans.length
      ? new Map(
          (await c.query(`SELECT k.code, s.code_key FROM sku_codes k JOIN skus s ON s.ws_id=k.ws_id AND s.id=k.sku_id WHERE k.ws_id=$1 AND k.code = ANY($2::text[])`, [ctx.wsId, jans]))
            .rows.map((x) => [x.code as string, x.code_key as string]),
        )
      : new Map<string, string>();
    const janSeen = new Map<string, number>();
    for (const r of results) {
      const v = r.values;
      if (v.code !== v.code.trim()) r.errors.push('SKUコードの前後に空白があります');
      if (v.code.length > 60) r.errors.push('SKUコードは60文字までです');
      if (v.name.length > 200) r.errors.push('商品名は200文字までです');
      if (v.unit.trim().length > 10) r.errors.push('単位は10文字までです');
      const nums = ['safety_stock', 'reorder_point', 'target_stock', 'min_order_qty', 'order_multiple'].map((k) => v[k].trim());
      if (nums.some(Boolean) && !nums.every(Boolean)) r.errors.push('補充設定（安全在庫・発注点・目標在庫・最小発注数量・発注単位）はすべて入力するか、すべて空欄にしてください');
      if (nums.every(Boolean)) {
        const vals = [
          intField(r, 'safety_stock', '安全在庫', 0, MAX_BALANCE),
          intField(r, 'reorder_point', '発注点', 0, MAX_BALANCE),
          intField(r, 'target_stock', '目標在庫', 1, MAX_BALANCE),
          intField(r, 'min_order_qty', '最小発注数量', 0, MAX_OP_QTY),
          intField(r, 'order_multiple', '発注単位', 1, MAX_OP_QTY),
        ];
        if (vals.every((x) => x !== null)) {
          const err = validateReplenishSettings({ safetyStock: vals[0]!, reorderPoint: vals[1]!, targetStock: vals[2]!, minOrderQty: vals[3]!, orderMultiple: vals[4]! });
          if (err) r.errors.push(err);
        }
      }
      intField(r, 'lead_time_days', 'リードタイム日数', 0, 3650);
      if (v.supplier_code.trim() && !sups.has(codeKey(v.supplier_code))) r.errors.push(`標準仕入先コード「${v.supplier_code}」が登録されていません（先に仕入先を登録してください）`);
      const jan = v.jan.trim();
      if (jan) {
        const kindJ = jan.length === 8 ? 'EAN8' : 'JAN13';
        const vj = validateBarcode(jan, kindJ);
        if (!vj.ok) r.errors.push(`JAN「${jan}」：${vj.message}`);
        const owner = janOwners.get(jan);
        if (owner && owner !== codeKey(v.code)) r.errors.push(`JAN「${jan}」は別のSKUに登録済みです`);
        if (janSeen.has(jan)) r.errors.push(`JAN「${jan}」がファイル内の${janSeen.get(jan)}行目と重複しています`);
        else janSeen.set(jan, r.rowNo);
      }
      const ex = existing.get(codeKey(v.code));
      if (ex) {
        r.action = 'exists';
        r.errors.push(`SKUコード「${v.code}」は登録済みです（取込で既存SKUを上書きしません。変更は画面から行ってください）`);
      } else r.action = 'create';
    }
  }

  if (kind === 'locations') {
    dupCheck('code', '場所コード');
    const existing = await locByKey(results.map((r) => codeKey(r.values.code)));
    for (const r of results) {
      const k = r.values.kind.trim();
      if (k && !['通常', '保留', 'normal', 'hold'].includes(k)) r.errors.push(`種類「${k}」は「通常」または「保留」です`);
      if (r.values.code.length > 40) r.errors.push('場所コードは40文字までです');
      if (r.values.name.length > 100) r.errors.push('場所名は100文字までです');
      const ex = existing.get(codeKey(r.values.code));
      if (ex) {
        const same = ex.name === r.values.name.trim() && ex.kind === (k === '保留' || k === 'hold' ? 'hold' : 'normal');
        if (same) r.action = 'skip_same';
        else r.errors.push(`場所コード「${r.values.code}」は登録済みで内容が異なります（衝突）`);
      } else r.action = 'create';
    }
  }

  if (kind === 'suppliers') {
    dupCheck('code', '仕入先コード');
    const existing = await supByKey(results.map((r) => codeKey(r.values.code)));
    for (const r of results) {
      intField(r, 'lead_time_days', 'リードタイム日数', 0, 3650);
      if (r.values.code.length > 40) r.errors.push('仕入先コードは40文字までです');
      const ex = existing.get(codeKey(r.values.code));
      if (ex) {
        if (ex.name === r.values.name.trim()) r.action = 'skip_same';
        else r.errors.push(`仕入先コード「${r.values.code}」は登録済みで内容が異なります（衝突）`);
      } else r.action = 'create';
    }
  }

  const deltas = new Map<string, { sku: string; location: string; delta: number }>();
  const addDelta = (skuCode: string, locName: string, d: number) => {
    const k = `${skuCode}|${locName}`;
    const cur = deltas.get(k) ?? { sku: skuCode, location: locName, delta: 0 };
    cur.delta += d;
    deltas.set(k, cur);
  };

  if (kind === 'initial_stock' || kind === 'po_drafts' || kind === 'movements') {
    const skus = await skuByKey(results.map((r) => codeKey(r.values.sku_code)));
    const locs = await locByKey(results.flatMap((r) => [codeKey(r.values.location_code), codeKey(r.values.to_location_code ?? '')]).filter(Boolean));
    for (const r of results) {
      const s = skus.get(codeKey(r.values.sku_code));
      if (r.values.sku_code.trim() && !s) r.errors.push(`SKUコード「${r.values.sku_code}」が登録されていません（似たコードへの自動置換はしません）`);
      else if (s?.archived) r.errors.push(`SKU「${s.code}」はアーカイブ済みです`);
      const l = locs.get(codeKey(r.values.location_code));
      if (r.values.location_code.trim() && !l) r.errors.push(`場所コード「${r.values.location_code}」が登録されていません`);
      else if (l?.archived) r.errors.push(`場所「${l.name}」はアーカイブ済みです`);
      else if (l?.stocktake_id && kind !== 'po_drafts') r.errors.push(`場所「${l.name}」は棚卸中です`);
      intField(r, 'qty', '数量', 1, MAX_OP_QTY, true);
    }
    if (kind === 'initial_stock') {
      const seen = new Map<string, number>();
      const pairs: [string, string, RowResult][] = [];
      for (const r of results) {
        const s = skus.get(codeKey(r.values.sku_code));
        const l = locs.get(codeKey(r.values.location_code));
        if (!s || !l) continue;
        const k = `${s.id}|${l.id}`;
        if (seen.has(k)) r.errors.push(`同じSKU・場所の行が${seen.get(k)}行目と重複しています`);
        else seen.set(k, r.rowNo);
        pairs.push([s.id, l.id, r]);
      }
      if (pairs.length) {
        const ex = await c.query(
          `SELECT DISTINCT e.sku_id, e.location_id FROM ledger_events e JOIN unnest($2::uuid[], $3::uuid[]) t(s,l) ON e.sku_id=t.s AND e.location_id=t.l WHERE e.ws_id=$1`,
          [ctx.wsId, pairs.map((p) => p[0]), pairs.map((p) => p[1])],
        );
        const has = new Set(ex.rows.map((x) => `${x.sku_id}|${x.location_id}`));
        for (const [s, l, r] of pairs) if (has.has(`${s}|${l}`)) r.errors.push('この SKU・場所には既に履歴があるため初期在庫にできません');
      }
      for (const r of results) {
        const q = parseStrictInt(r.values.qty);
        if (!r.errors.length && q) addDelta(r.values.sku_code, locs.get(codeKey(r.values.location_code))!.name, q);
        r.action = r.errors.length ? undefined : 'import';
      }
    }
    if (kind === 'po_drafts') {
      const sups = await supByKey(results.map((r) => codeKey(r.values.supplier_code)));
      for (const r of results) {
        const sp = sups.get(codeKey(r.values.supplier_code));
        if (r.values.supplier_code.trim() && !sp) r.errors.push(`仕入先コード「${r.values.supplier_code}」が登録されていません`);
        else if (sp?.archived) r.errors.push('アーカイブ済みの仕入先です');
        const dd = r.values.due_date.trim();
        if (dd && !isValidDate(dd)) r.errors.push(`希望納期「${dd}」は YYYY-MM-DD 形式の実在日で入力してください`);
        r.action = r.errors.length ? undefined : 'import';
      }
      summary.draftCount = new Set(results.filter((r) => !r.errors.length).map((r) => `${codeKey(r.values.supplier_code)}|${r.values.group.trim()}`)).size;
    }
    if (kind === 'movements') {
      const extSeen = new Map<string, number>();
      const extIds = results.map((r) => r.values.external_id.trim()).filter(Boolean);
      const extExisting = extIds.length
        ? new Map((await c.query(`SELECT external_id, external_hash FROM operations WHERE ws_id=$1 AND external_id = ANY($2::text[])`, [ctx.wsId, extIds])).rows.map((x) => [x.external_id, x.external_hash]))
        : new Map();
      for (const r of results) {
        const t = MOVEMENT_TYPES[r.values.type.trim()];
        if (!t) r.errors.push(`種別「${r.values.type}」は 発注外入庫／出庫／場所移動／数量訂正増／数量訂正減／廃棄 のいずれかです`);
        if (!isValidDate(r.values.date.trim())) r.errors.push(`日付「${r.values.date}」は YYYY-MM-DD 形式の実在日で入力してください`);
        const l = locs.get(codeKey(r.values.location_code));
        if (t === 'transfer') {
          const to = locs.get(codeKey(r.values.to_location_code));
          if (!to) r.errors.push('場所移動には登録済みの移動先場所コードが必要です');
          else if (to.stocktake_id) r.errors.push(`移動先「${to.name}」は棚卸中です`);
          else if (to.archived) r.errors.push(`移動先「${to.name}」はアーカイブ済みです`);
          if (to && l && to.id === l.id) r.errors.push('移動元と移動先が同じです');
          if (to && l && l.kind === 'hold' && to.kind === 'normal' && !r.values.reason.trim()) r.errors.push('保留から通常への移動には理由が必要です');
        }
        if (t === 'issue') {
          if (!PURPOSES[r.values.purpose.trim()]) r.errors.push('出庫の目的は 販売／サンプル配布／業務使用／その他 のいずれかです');
          if (l && l.kind === 'hold') r.errors.push(`「${l.name}」は保留場所のため出庫できません`);
        }
        if ((t === 'outside_receipt' || t === 'correction_increase' || t === 'correction_decrease' || t === 'disposal') && !r.values.reason.trim()) {
          r.errors.push('この種別には理由が必要です');
        }
        if (r.values.reason.length > 500) r.errors.push('理由は500文字までです');
        if (r.values.ref.length > 100) r.errors.push('参照番号は100文字までです');
        const ext = r.values.external_id.trim();
        if (ext) {
          if (ext.length > 100) r.errors.push('外部IDは100文字までです');
          if (extSeen.has(ext)) r.errors.push(`外部ID「${ext}」がファイル内の${extSeen.get(ext)}行目と重複しています`);
          else extSeen.set(ext, r.rowNo);
          const h = rowHash(r.values);
          if (extExisting.has(ext)) {
            if (extExisting.get(ext) === h) r.action = 'skip_same';
            else r.errors.push(`外部ID「${ext}」は取込済みで内容が異なります（衝突）`);
          }
        }
        if (!r.errors.length && !r.action) {
          r.action = 'import';
          const q = parseStrictInt(r.values.qty)!;
          const sc = r.values.sku_code;
          const ln = l!.name;
          if (t === 'outside_receipt' || t === 'correction_increase') addDelta(sc, ln, q);
          else if (t === 'transfer') {
            addDelta(sc, ln, -q);
            addDelta(sc, locs.get(codeKey(r.values.to_location_code))!.name, q);
          } else addDelta(sc, ln, -q);
        }
      }
    }
  }
  return { results, deltas: [...deltas.values()], summary };
}

function rowHash(v: Record<string, string>) {
  return sha256(stableStringify(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.trim()]))));
}

// ---------- プレビュー ----------
export async function previewImport(
  ctx: Ctx,
  input: { kind: ImportKind; data: Buffer; fileName: string; encoding: 'utf-8' | 'shift_jis'; mapping?: Record<string, number> },
) {
  if (!IMPORT_KINDS.includes(input.kind)) fail('VALIDATION', '取込種別が不正です');
  const fileHash = sha256(input.data);
  const text = decodeCsv(input.data, input.encoding);
  const { header, rows } = parseCsv(text);
  const max = ['skus', 'locations', 'suppliers'].includes(input.kind) ? CSV_MAX_MASTER_ROWS : CSV_MAX_QTY_ROWS;
  if (rows.length > max) fail('TOO_LARGE', `この種別の取込は${max.toLocaleString()}行までです（ファイルは${rows.length.toLocaleString()}行）。途中で切らずに停止しました。ファイルを分割してください。`);
  const mapping = input.mapping ?? autoMapping(input.kind, header);
  for (const [k, i] of Object.entries(mapping)) {
    if (!FIELDS[input.kind].some((f) => f.key === k)) fail('VALIDATION', `不明な項目「${k}」`);
    if (!Number.isInteger(i) || i < 0 || i >= header.length) fail('VALIDATION', `列番号が不正です（${k}）`);
  }
  const res = await writeTx(ctx, async (c) => {
    const prior = await c.query(`SELECT id, committed_at, result FROM import_batches WHERE ws_id=$1 AND kind=$2 AND file_hash=$3 AND status='committed'`, [ctx.wsId, input.kind, fileHash]);
    const a = await analyze(c, ctx, input.kind, rows, mapping);
    const id = uuid();
    const warnings: string[] = [];
    if (input.kind === 'skus' && header.some((h) => /在庫/.test(h))) warnings.push('「在庫」を含む列は取り込みません。数量は「初期在庫」CSVで登録してください。');
    if (prior.rowCount) warnings.push(`同じファイルは ${new Date(prior.rows[0].committed_at).toISOString().slice(0, 10)} に取込済みです。確定すると既存の結果を表示します（二重取込しません）。`);
    await c.query(
      `INSERT INTO import_batches (ws_id,id,kind,file_hash,file_name,encoding,mapping,status,row_count,rows,errors,warnings) VALUES ($1,$2,$3,$4,$5,$6,$7,'preview',$8,$9,$10,$11)`,
      [
        ctx.wsId,
        id,
        input.kind,
        fileHash,
        input.fileName.slice(0, 200),
        input.encoding,
        JSON.stringify(mapping),
        rows.length,
        JSON.stringify(rows),
        JSON.stringify(a.results.filter((r) => r.errors.length).map((r) => ({ rowNo: r.rowNo, errors: r.errors }))),
        JSON.stringify(warnings),
      ],
    );
    return { id, a, warnings, alreadyCommitted: prior.rowCount ? prior.rows[0].id : null };
  });
  return {
    importId: res.id,
    kind: input.kind,
    fileHash,
    header,
    mapping,
    fields: FIELDS[input.kind],
    rowCount: rows.length,
    errorCount: res.a.results.filter((r) => r.errors.length).length,
    rows: res.a.results.slice(0, 500),
    deltas: res.a.deltas,
    summary: res.a.summary,
    warnings: res.warnings,
    alreadyCommittedImportId: res.alreadyCommitted,
  };
}

// ---------- 確定 ----------
export async function commitImport(ctx: Ctx, importId: string, cmd: { idempotencyKey: string; excludedRows: number[]; businessDate: string }) {
  return runCommand(ctx, 'import_commit', cmd.idempotencyKey, { importId, ...cmd }, async (c) => {
    const b = await c.query(`SELECT * FROM import_batches WHERE ws_id=$1 AND id=$2 FOR UPDATE`, [ctx.wsId, importId]);
    if (b.rowCount === 0) fail('NOT_FOUND', '取込が見つかりません');
    const batch = b.rows[0];
    if (batch.status !== 'preview') fail('STATE', 'この取込は既に確定または破棄されています');
    // 同じ事業者・種別・ファイルハッシュの確定済みがあれば既存結果を示す（マッピング変更ですり抜けない）
    const prior = await c.query(`SELECT id, result FROM import_batches WHERE ws_id=$1 AND kind=$2 AND file_hash=$3 AND status='committed'`, [
      ctx.wsId,
      batch.kind,
      batch.file_hash,
    ]);
    if (prior.rowCount) fail('IMPORT_DUPLICATE', '同じファイルは取込済みです。二重取込はしません。', { importId: prior.rows[0].id, result: prior.rows[0].result });
    const rows: string[][] = batch.rows;
    const mapping: Record<string, number> = batch.mapping;
    const excluded = new Set(cmd.excludedRows);
    const a = await analyze(c, ctx, batch.kind, rows, mapping);
    const targets = a.results.filter((r) => !excluded.has(r.rowNo));
    const remainingErrors = targets.filter((r) => r.errors.length);
    if (remainingErrors.length) {
      fail('VALIDATION', `エラーのある行が${remainingErrors.length}件あります。修正するか、明示的に除外してください。`, {
        rows: remainingErrors.slice(0, 100).map((r) => ({ rowNo: r.rowNo, errors: r.errors })),
      });
    }
    const todo = targets.filter((r) => r.action === 'create' || r.action === 'import');
    const result = await commitRows(c, ctx, batch.kind, todo, importId, cmd.businessDate);
    const summary = { imported: todo.length, skippedSame: targets.filter((r) => r.action === 'skip_same').length, excluded: excluded.size, ...result };
    await c.query(`UPDATE import_batches SET status='committed', committed_at=now(), excluded_rows=$3, result=$4 WHERE ws_id=$1 AND id=$2`, [
      ctx.wsId,
      importId,
      JSON.stringify([...excluded]),
      JSON.stringify(summary),
    ]);
    return summary;
  });
}

async function commitRows(c: Tx, ctx: Ctx, kind: ImportKind, rows: RowResult[], importId: string, businessDate: string) {
  const out: Record<string, unknown> = {};
  const num = (v: string) => (v.trim() ? parseStrictInt(v)! : null);
  if (kind === 'suppliers') {
    for (const r of rows) {
      const v = r.values;
      await insertSupplier(c, ctx.wsId, {
        code: v.code,
        name: v.name.trim(),
        contactName: v.contact_name.trim(),
        contact: v.contact.trim(),
        leadTimeDays: num(v.lead_time_days),
        note: v.note,
      });
    }
  }
  if (kind === 'locations') {
    for (const r of rows) {
      const v = r.values;
      await insertLocation(c, ctx.wsId, { code: v.code, name: v.name.trim(), description: v.description, kind: v.kind.trim() === '保留' || v.kind.trim() === 'hold' ? 'hold' : 'normal' });
    }
  }
  if (kind === 'skus') {
    const sups = new Map(
      (await c.query(`SELECT id, code_key FROM suppliers WHERE ws_id=$1`, [ctx.wsId])).rows.map((x) => [x.code_key as string, x.id as string]),
    );
    for (const r of rows) {
      const v = r.values;
      const hasRep = v.reorder_point.trim() !== '';
      const { id } = await insertSku(c, ctx.wsId, {
        code: v.code,
        name: v.name.trim(),
        groupName: v.group.trim(),
        color: v.color.trim(),
        size: v.size.trim(),
        attrs: v.attrs.trim(),
        category: v.category.trim(),
        brand: v.brand.trim(),
        unit: v.unit.trim() || '個',
        supplierId: v.supplier_code.trim() ? sups.get(codeKey(v.supplier_code))! : null,
        memo: v.memo,
        replenish: hasRep
          ? {
              safetyStock: num(v.safety_stock)!,
              reorderPoint: num(v.reorder_point)!,
              targetStock: num(v.target_stock)!,
              minOrderQty: num(v.min_order_qty)!,
              orderMultiple: num(v.order_multiple)!,
            }
          : null,
        leadTimeDays: num(v.lead_time_days),
      });
      if (v.jan.trim()) await insertSkuCode(c, ctx.wsId, id, v.jan.trim(), v.jan.trim().length === 8 ? 'EAN8' : 'JAN13');
    }
  }
  if (kind === 'initial_stock' || kind === 'movements' || kind === 'po_drafts') {
    const skus = new Map((await c.query(`SELECT id, code_key FROM skus WHERE ws_id=$1`, [ctx.wsId])).rows.map((x) => [x.code_key as string, x.id as string]));
    const locs = new Map((await c.query(`SELECT id, code_key FROM locations WHERE ws_id=$1`, [ctx.wsId])).rows.map((x) => [x.code_key as string, x.id as string]));
    const S = (v: string) => skus.get(codeKey(v))!;
    const L = (v: string) => locs.get(codeKey(v))!;
    if (kind === 'initial_stock') {
      const lines = rows.map((r) => ({ skuId: S(r.values.sku_code), locationId: L(r.values.location_code), qty: parseStrictInt(r.values.qty)! }));
      const ops = [];
      for (let i = 0; i < lines.length; i += MAX_LINES_PER_OP) {
        const op = await initialStockTx(c, ctx, { idempotencyKey: 'csvimport', businessDate, note: 'CSV取込', lines: lines.slice(i, i + MAX_LINES_PER_OP) }, { importId });
        ops.push(op.opNo);
      }
      out.opNos = ops;
    }
    if (kind === 'po_drafts') {
      const sups = new Map((await c.query(`SELECT id, code_key FROM suppliers WHERE ws_id=$1`, [ctx.wsId])).rows.map((x) => [x.code_key as string, x.id as string]));
      const groups = new Map<string, RowResult[]>();
      for (const r of rows) {
        const g = `${codeKey(r.values.supplier_code)}|${r.values.group.trim()}`;
        groups.set(g, [...(groups.get(g) ?? []), r]);
      }
      const created = [];
      for (const [, rs] of groups) {
        const d = await createDraftTx(c, ctx, {
          supplierId: sups.get(codeKey(rs[0].values.supplier_code))!,
          dueDate: null,
          locationId: null,
          externalRef: '',
          supplierNote: '',
          internalMemo: `CSV取込 ${importId.slice(0, 8)}`,
          replacesPoId: null,
          lines: rs.map((r) => ({ skuId: S(r.values.sku_code), qty: parseStrictInt(r.values.qty)!, dueDate: r.values.due_date.trim() || null, locationId: L(r.values.location_code) })),
        });
        created.push(d.poNo);
      }
      out.poNos = created;
    }
    if (kind === 'movements') {
      // 取込行の場所をまとめて先にロックし、以降の伝票ごとのロック待ちを避ける
      const allLocs = [...new Set(rows.flatMap((r) => [L(r.values.location_code), r.values.to_location_code.trim() ? L(r.values.to_location_code) : null]).filter(Boolean) as string[])];
      const { lockLocations } = await import('./inventory.js');
      await lockLocations(c, ctx.wsId, allLocs);
      const opNos = [];
      for (const r of rows) {
        const v = r.values;
        const t = MOVEMENT_TYPES[v.type.trim()];
        const q = parseStrictInt(v.qty)!;
        const date = v.date.trim();
        const reason = v.reason.trim();
        const extra = { importId, externalId: v.external_id.trim() || null, externalHash: v.external_id.trim() ? rowHash(v) : null };
        const base = { idempotencyKey: 'csvimport', businessDate: date, note: `CSV取込 ${r.rowNo}行目`, expected: [] };
        let op;
        if (t === 'outside_receipt') op = await outsideReceiptTx(c, ctx, { ...base, reason, externalRef: v.ref.trim(), lines: [{ skuId: S(v.sku_code), locationId: L(v.location_code), qty: q }] }, extra);
        else if (t === 'issue')
          op = await issueTx(
            c,
            ctx,
            { ...base, purpose: PURPOSES[v.purpose.trim()], externalRef: v.ref.trim(), destinationLabel: '', lines: [{ skuId: S(v.sku_code), locationId: L(v.location_code), qty: q }] },
            extra,
          );
        else if (t === 'transfer')
          op = await transferTx(c, ctx, { ...base, fromLocationId: L(v.location_code), toLocationId: L(v.to_location_code), reason, lines: [{ skuId: S(v.sku_code), qty: q }] }, extra);
        else if (t === 'disposal')
          op = await applyOperation(c, ctx, {
            kind: 'disposal',
            businessDate: date,
            reason,
            note: base.note,
            ...extra,
            movements: [{ skuId: S(v.sku_code), locationId: L(v.location_code), delta: -q, kind: 'disposal', reason }],
          });
        else
          op = await correctionTx(
            c,
            ctx,
            { ...base, reason, lines: [{ skuId: S(v.sku_code), locationId: L(v.location_code), direction: t === 'correction_increase' ? 'increase' : 'decrease', qty: q }] },
            extra,
          );
        opNos.push(op.opNo);
      }
      out.opCount = opNos.length;
      out.firstOpNo = opNos[0] ?? null;
      out.lastOpNo = opNos[opNos.length - 1] ?? null;
    }
  }
  return out;
}

export async function discardImport(ctx: Ctx, importId: string) {
  return writeTx(ctx, async (c) => {
    const r = await c.query(`UPDATE import_batches SET status='discarded', rows='[]' WHERE ws_id=$1 AND id=$2 AND status='preview'`, [ctx.wsId, importId]);
    if (r.rowCount === 0) fail('STATE', '破棄できる取込がありません');
    return { id: importId };
  });
}

export async function listImports(ctx: Ctx) {
  return readTx(ctx, async (c) => {
    const r = await c.query(
      `SELECT id, kind, file_name, file_hash, encoding, status, row_count, result, created_at, committed_at FROM import_batches WHERE ws_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [ctx.wsId],
    );
    return r.rows;
  });
}

// ---------- 出力 ----------
/** セル値：数値は検証済みのものだけ数値として出し、文字列は必ず引用し、数式として解釈される先頭文字を無効化する */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    return String(v);
  }
  let s = String(v);
  if (/^[=+\-@\t\r＝＋－＠]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return '﻿' + [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}
