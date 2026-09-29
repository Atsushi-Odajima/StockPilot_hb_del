// CSV 出力。期間・単位・判定条件が分かる列を含める。
import { fail } from '../errors.js';
import { type Ctx, readTx, today } from './context.js';
import { toCsv } from './csv.js';
import { loadReplenishRows } from './replenish.js';
import { EVENT_KIND_LABEL, type EventKind } from './inventory.js';
import { PURPOSE_LABEL } from '../../shared/schemas.js';
import { poDisplayStatus, PO_STATUS_LABEL } from '../../domain/po.js';
import { formatTokyoDateTime } from '../../shared/dates.js';
import { getStocktake } from './stocktake.js';

export type ExportKind = 'skus' | 'stock' | 'history' | 'pos' | 'replenish' | 'transfers' | 'stocktake';

export async function exportCsv(ctx: Ctx, kind: ExportKind, q: { from?: string; to?: string; stocktakeId?: string }): Promise<{ csv: string; filename: string }> {
  const t = today(ctx);
  const asOf = formatTokyoDateTime(ctx.now());
  if (kind === 'skus') {
    const rows = await readTx(ctx, (c) =>
      c.query(
        `SELECT s.*, sp.code supplier_code, (SELECT string_agg(k.code || ':' || k.kind, ' | ' ORDER BY k.created_at) FROM sku_codes k WHERE k.ws_id=s.ws_id AND k.sku_id=s.id) codes
         FROM skus s LEFT JOIN suppliers sp ON sp.ws_id=s.ws_id AND sp.id=s.supplier_id WHERE s.ws_id=$1 ORDER BY s.code`,
        [ctx.wsId],
      ),
    );
    return {
      filename: `商品一覧_${t}.csv`,
      csv: toCsv(
        ['SKUコード', '商品名', '商品グループ', '色', 'サイズ', 'その他属性', 'カテゴリ', 'ブランド', '単位', '標準仕入先コード', '安全在庫', '発注点', '目標在庫', '最小発注数量', '発注単位', 'リードタイム日数', '関連コード', '状態', 'SKU固定ID'],
        rows.rows.map((s) => [
          s.code,
          s.name,
          s.group_name,
          s.color,
          s.size,
          s.attrs,
          s.category,
          s.brand,
          s.unit,
          s.supplier_code ?? '',
          s.safety_stock,
          s.reorder_point,
          s.target_stock,
          s.min_order_qty,
          s.order_multiple,
          s.lead_time_days,
          s.codes ?? '',
          s.archived ? 'アーカイブ' : '有効',
          s.id,
        ]),
      ),
    };
  }
  if (kind === 'stock') {
    const rows = await readTx(ctx, (c) =>
      c.query(
        `SELECT s.code, s.name, s.color, s.size, s.unit, l.code lcode, l.name lname, l.kind, b.qty, b.last_in_date, b.last_out_date
         FROM balances b JOIN skus s ON s.ws_id=b.ws_id AND s.id=b.sku_id JOIN locations l ON l.ws_id=b.ws_id AND l.id=b.location_id
         WHERE b.ws_id=$1 AND b.qty>0 ORDER BY s.code, l.code`,
        [ctx.wsId],
      ),
    );
    return {
      filename: `場所別在庫_${t}.csv`,
      csv: toCsv(
        ['時点', 'SKUコード', '商品名', '色', 'サイズ', '場所コード', '場所名', '場所種類', '現物在庫', '単位', '利用可能に含む', '最終入庫日', '最終出庫日'],
        rows.rows.map((r) => [asOf, r.code, r.name, r.color, r.size, r.lcode, r.lname, r.kind === 'hold' ? '保留' : '通常', Number(r.qty), r.unit, r.kind === 'hold' ? 'いいえ' : 'はい', r.last_in_date ?? '', r.last_out_date ?? '']),
      ),
    };
  }
  if (kind === 'history' || kind === 'transfers') {
    const from = q.from ?? '2000-01-01';
    const to = q.to ?? '2100-12-31';
    const rows = await readTx(ctx, (c) =>
      c.query(
        `SELECT e.*, o.op_no, o.purpose, o.external_ref, o.note, o.destination_label, p.po_no, st.st_no, src.id src_id,
           (SELECT oo.op_no FROM ledger_events x JOIN operations oo ON oo.ws_id=x.ws_id AND oo.id=x.op_id WHERE x.ws_id=e.ws_id AND x.id=coalesce(e.reversal_of_event_id, e.source_event_id)) ref_op_no
         FROM ledger_events e JOIN operations o ON o.ws_id=e.ws_id AND o.id=e.op_id LEFT JOIN purchase_orders p ON p.ws_id=o.ws_id AND p.id=o.po_id
         LEFT JOIN stocktakes st ON st.ws_id=o.ws_id AND st.id=o.stocktake_id LEFT JOIN ledger_events src ON src.ws_id=e.ws_id AND src.id=e.source_event_id
         WHERE e.ws_id=$1 AND e.business_date BETWEEN $2 AND $3 ${kind === 'transfers' ? `AND e.kind IN ('transfer_out','transfer_in')` : ''}
         ORDER BY e.seq LIMIT 200000`,
        [ctx.wsId, from, to],
      ),
    );
    return {
      filename: `${kind === 'transfers' ? '移動履歴' : '入出庫履歴'}_${from}_${to}.csv`,
      csv: toCsv(
        ['期間開始', '期間終了', '確定順', '伝票番号', '業務日付', '確定日時', '種別', '目的', 'SKUコード', '商品名', '場所コード', '場所名', '増減', '単位', '発注番号', '棚卸番号', '取消・返品元伝票', '理由', '参照番号', '行先ラベル', 'メモ'],
        rows.rows.map((e) => [
          from,
          to,
          Number(e.seq),
          e.op_no,
          e.business_date,
          formatTokyoDateTime(e.committed_at),
          EVENT_KIND_LABEL[e.kind as EventKind],
          e.purpose ? PURPOSE_LABEL[e.purpose] : '',
          e.sku_snapshot.code,
          e.sku_snapshot.name,
          e.location_snapshot.code,
          e.location_snapshot.name,
          e.qty,
          e.sku_snapshot.unit,
          e.po_no ?? '',
          e.st_no ?? '',
          e.ref_op_no ?? '',
          e.reason,
          e.external_ref,
          e.destination_label,
          e.note,
        ]),
      ),
    };
  }
  if (kind === 'pos') {
    const rows = await readTx(ctx, (c) =>
      c.query(
        `SELECT p.po_no, p.status, p.ordered_date, p.external_ref, s.code scode, s.name sname, pl.line_no, k.code, k.name, k.unit, pl.qty, pl.received_qty, pl.cancelled_qty,
           coalesce(pl.due_date,p.due_date) due, l.name lname
         FROM po_lines pl JOIN purchase_orders p ON p.ws_id=pl.ws_id AND p.id=pl.po_id JOIN suppliers s ON s.ws_id=p.ws_id AND s.id=p.supplier_id
         JOIN skus k ON k.ws_id=pl.ws_id AND k.id=pl.sku_id JOIN locations l ON l.ws_id=pl.ws_id AND l.id=pl.location_id
         WHERE pl.ws_id=$1 ORDER BY p.po_no, pl.line_no`,
        [ctx.wsId],
      ),
    );
    return {
      filename: `発注一覧_${t}.csv`,
      csv: toCsv(
        ['時点', '発注番号', '状態', '発注日', '仕入先コード', '仕入先名', '明細No', 'SKUコード', '商品名', '単位', '発注数量Q', '受領済みR', '打切りC', '発注残O=Q-R-C', '希望納期', '納期超過', '納入場所', '外部注文番号'],
        rows.rows.map((r) => {
          const ds = r.status === 'draft' ? 'draft' : poDisplayStatus('placed', [{ qty: r.qty, received: r.received_qty, cancelled: r.cancelled_qty }]);
          const o = r.qty - r.received_qty - r.cancelled_qty;
          return [
            asOf,
            r.po_no,
            PO_STATUS_LABEL[ds],
            r.ordered_date ?? '',
            r.scode,
            r.sname,
            r.line_no,
            r.code,
            r.name,
            r.unit,
            r.qty,
            r.received_qty,
            r.cancelled_qty,
            r.status === 'draft' ? 0 : o,
            r.due ?? '',
            r.status === 'placed' && o > 0 && r.due && r.due < t ? 'はい' : '',
            r.lname,
            r.external_ref,
          ];
        }),
      ),
    };
  }
  if (kind === 'replenish') {
    const rows = await loadReplenishRows(ctx);
    return {
      filename: `補充候補_${t}.csv`,
      csv: toCsv(
        ['時点', 'SKUコード', '商品名', '単位', '利用可能U(通常場所)', '保留', '発注残O(通常場所・発注済み)', '補充判断数量P=U+O', '安全在庫', '発注点', '目標在庫', '最小発注数量', '発注単位', '推奨数', '安全在庫割れ', '納期超過の発注残', '既存下書き数量', '標準仕入先', '判定'],
        rows.map((r) => [
          asOf,
          r.skuCode,
          r.skuName,
          r.unit,
          r.available,
          r.hold,
          r.onOrder,
          r.p,
          r.safetyStock,
          r.reorderPoint,
          r.targetStock,
          r.minOrderQty,
          r.orderMultiple,
          r.recommended,
          r.belowSafety ? 'はい' : '',
          r.overdueOnOrder,
          r.draftQty,
          r.supplierName ?? '',
          r.reason,
        ]),
      ),
    };
  }
  if (kind === 'stocktake') {
    if (!q.stocktakeId) fail('VALIDATION', '棚卸を指定してください');
    const st = await getStocktake(ctx, q.stocktakeId!);
    return {
      filename: `棚卸差異_${st.stNo}.csv`,
      csv: toCsv(
        ['棚卸番号', '場所', '状態', '棚卸日', '確定日時', 'SKUコード', '商品名', '色', 'サイズ', '単位', '開始時理論在庫', '実数', '差異', '理由', '理由メモ'],
        st.lines.map((l) => [
          st.stNo,
          st.locationName,
          { counting: '計数中', review: '差異確認', confirmed: '確定', cancelled: '中止' }[st.status as string],
          st.businessDate,
          st.confirmedAt ? formatTokyoDateTime(st.confirmedAt) : '',
          l.code,
          l.name,
          l.color,
          l.size,
          l.unit,
          l.theoretical,
          l.counted,
          l.diff,
          l.reasonCode ? ({ miscount: '過去の数え間違い', unrecorded_in: '入庫の記録漏れ', unrecorded_out: '出庫の記録漏れ', damage: '破損・劣化', loss: '紛失・不明', found: '見つかった', other: 'その他' } as Record<string, string>)[l.reasonCode] : '',
          l.reasonNote,
        ]),
      ),
    };
  }
  return fail('VALIDATION', '出力種別が不正です');
}
