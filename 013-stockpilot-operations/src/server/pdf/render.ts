// 帳票PDF（A4）。発行時スナップショットのみを入力とし、許可した項目だけを描画する。
// 内部メモ・他事業者データ・認証情報・サーバーのパスは入力に含めない（snapshot 生成側で除外）。
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { formatTokyoDateTime } from '../../shared/dates.js';

const FONT_DIR = path.resolve(process.env.FONT_DIR ?? 'assets/fonts');
let fontCache: { regular: Buffer; bold: Buffer } | null = null;
function fonts() {
  fontCache ??= {
    regular: fs.readFileSync(path.join(FONT_DIR, 'NotoSansJP_400Regular.ttf')),
    bold: fs.readFileSync(path.join(FONT_DIR, 'NotoSansJP_700Bold.ttf')),
  };
  return fontCache;
}

function newDoc(title: string) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: title, Producer: 'StockPilot', Creator: 'StockPilot' } });
  const f = fonts();
  doc.registerFont('jp', f.regular);
  doc.registerFont('jpb', f.bold);
  doc.font('jp');
  return doc;
}

function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

const mm = (v: number) => (v * 72) / 25.4;

// ---------- 数量発注書 ----------
export interface PoSheetSnapshot {
  poNo: string;
  statusLabel: string;
  issuedAt: string;
  orderedDate: string | null;
  dueDate: string | null;
  business: { name: string };
  supplier: { code: string; name: string; contactName: string };
  deliveryLocation: string | null;
  externalRef: string;
  supplierNote: string;
  lines: { lineNo: number; code: string; name: string; variant: string; qty: number; unit: string; dueDate: string | null; location: string }[];
}

interface Col {
  key: string;
  label: string;
  width: number;
  align?: 'left' | 'right' | 'center';
}

function table(doc: PDFKit.PDFDocument, cols: Col[], rows: Record<string, string>[], opts: { fontSize?: number } = {}) {
  const fs_ = opts.fontSize ?? 9;
  const left = doc.page.margins.left;
  const drawHeader = () => {
    let x = left;
    const y = doc.y;
    doc.font('jpb').fontSize(fs_);
    doc.rect(left, y - 2, cols.reduce((a, c) => a + c.width, 0), fs_ + 8).fill('#eeeeee');
    doc.fillColor('#000');
    for (const c of cols) {
      doc.text(c.label, x + 3, y + 1, { width: c.width - 6, align: c.align ?? 'left', lineBreak: false });
      x += c.width;
    }
    doc.font('jp');
    doc.y = y + fs_ + 8;
  };
  drawHeader();
  for (const r of rows) {
    const heights = cols.map((c) => doc.fontSize(fs_).heightOfString(r[c.key] ?? '', { width: c.width - 6 }));
    const h = Math.max(...heights, fs_ + 2) + 6;
    if (doc.y + h > doc.page.height - doc.page.margins.bottom - 30) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    let x = left;
    for (const c of cols) {
      doc.text(r[c.key] ?? '', x + 3, y + 3, { width: c.width - 6, align: c.align ?? 'left' });
      x += c.width;
    }
    doc
      .moveTo(left, y + h)
      .lineTo(left + cols.reduce((a, c) => a + c.width, 0), y + h)
      .strokeColor('#bbbbbb')
      .lineWidth(0.5)
      .stroke();
    doc.y = y + h;
  }
  doc.x = left;
}

function footer(doc: PDFKit.PDFDocument, text: string) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('jp')
      .fontSize(8)
      .fillColor('#555')
      .text(`${text}　${i + 1} / ${range.count}`, doc.page.margins.left, doc.page.height - 28, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: 'center',
        lineBreak: false,
      });
    doc.page.margins.bottom = bottom;
    doc.fillColor('#000');
  }
}

export async function renderPoSheet(s: PoSheetSnapshot): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `数量発注書 ${s.poNo}`, Producer: 'StockPilot' } });
  const f = fonts();
  doc.registerFont('jp', f.regular);
  doc.registerFont('jpb', f.bold);
  doc.font('jpb').fontSize(18).text('数量発注書', { align: 'center' });
  doc.moveDown(0.3);
  doc.font('jp').fontSize(9).fillColor('#444').text('金額・税額を含まない数量のみの発注書です。', { align: 'center' }).fillColor('#000');
  doc.moveDown(0.8);
  const top = doc.y;
  doc.font('jpb').fontSize(13).text(`${s.supplier.name} 御中`, 40, top, { width: 300 });
  if (s.supplier.contactName) doc.font('jp').fontSize(10).text(`ご担当：${s.supplier.contactName} 様`, { width: 300 });
  doc.font('jp').fontSize(9);
  const right = [
    `発注番号：${s.poNo}`,
    `発注日：${s.orderedDate ?? '（未発注・下書き）'}`,
    `希望納期：${s.dueDate ?? '明細ごと'}`,
    `発行：${formatTokyoDateTime(s.issuedAt)}`,
    s.externalRef ? `注文番号：${s.externalRef}` : '',
    `発注者：${s.business.name}`,
  ].filter(Boolean);
  doc.text(right.join('\n'), 340, top, { width: 215, align: 'right' });
  doc.y = Math.max(doc.y, top + 80);
  doc.x = 40;
  if (s.deliveryLocation) doc.fontSize(10).text(`納入場所：${s.deliveryLocation}`);
  doc.moveDown(0.6);
  table(
    doc,
    [
      { key: 'no', label: 'No', width: 28, align: 'right' },
      { key: 'code', label: 'SKU', width: 90 },
      { key: 'name', label: '商品名・バリエーション', width: 190 },
      { key: 'qty', label: '数量', width: 70, align: 'right' },
      { key: 'due', label: '希望納期', width: 70 },
      { key: 'loc', label: '納入場所', width: 67 },
    ],
    s.lines.map((l) => ({
      no: String(l.lineNo),
      code: l.code,
      name: l.variant ? `${l.name}\n${l.variant}` : l.name,
      qty: `${l.qty.toLocaleString('ja-JP')} ${l.unit}`,
      due: l.dueDate ?? s.dueDate ?? '',
      loc: l.location,
    })),
  );
  doc.moveDown(0.8);
  if (s.supplierNote) {
    doc.font('jpb').fontSize(10).text('備考');
    doc.font('jp').fontSize(9).text(s.supplierNote, { width: 515 });
  }
  footer(doc, `${s.poNo}`);
  return toBuffer(doc);
}

// ---------- 棚卸差異 ----------
export interface StocktakeSnapshot {
  stNo: string;
  location: { code: string; name: string };
  businessDate: string;
  confirmedAt: string;
  opNo: string | null;
  lines: { code: string; name: string; color: string; size: string; unit: string; theoretical: number; counted: number; diff: number; reason: string; reasonNote: string }[];
}

export async function renderStocktakeDiff(s: StocktakeSnapshot): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `棚卸差異 ${s.stNo}`, Producer: 'StockPilot' } });
  const f = fonts();
  doc.registerFont('jp', f.regular);
  doc.registerFont('jpb', f.bold);
  doc.font('jpb').fontSize(16).text('棚卸差異確認表', { align: 'center' });
  doc.moveDown(0.5);
  const diffs = s.lines.filter((l) => l.diff !== 0);
  doc
    .font('jp')
    .fontSize(10)
    .text(
      `棚卸番号：${s.stNo}　場所：${s.location.name}（${s.location.code}）\n棚卸日：${s.businessDate}　確定：${formatTokyoDateTime(s.confirmedAt)}　調整伝票：${s.opNo ?? 'なし（差異なし）'}\n対象 ${s.lines.length} SKU／差異あり ${diffs.length} SKU`,
    );
  doc.moveDown(0.6);
  table(
    doc,
    [
      { key: 'code', label: 'SKU', width: 80 },
      { key: 'name', label: '商品名', width: 150 },
      { key: 't', label: '開始時理論', width: 55, align: 'right' },
      { key: 'c', label: '実数', width: 55, align: 'right' },
      { key: 'd', label: '差異', width: 50, align: 'right' },
      { key: 'r', label: '理由', width: 125 },
    ],
    s.lines.map((l) => ({
      code: l.code,
      name: [l.name, [l.color, l.size].filter(Boolean).join(' / ')].filter(Boolean).join('\n'),
      t: `${l.theoretical}`,
      c: `${l.counted}`,
      d: l.diff === 0 ? '0' : l.diff > 0 ? `+${l.diff}` : `${l.diff}`,
      r: [l.reason, l.reasonNote].filter(Boolean).join('：'),
    })),
  );
  footer(doc, `棚卸差異 ${s.stNo}`);
  return toBuffer(doc);
}

// ---------- 内部QRラベル（A4 固定：3列×8段＝24枚） ----------
export interface LabelItem {
  payload: string; // SP:1:SKU:<id> 等
  title: string; // SKUコードまたは場所名
  subtitle: string; // 商品名・色サイズ、または場所種別
  note?: string; // JAN 等（テキストのみ）
}

export async function renderLabels(items: LabelItem[]): Promise<Buffer> {
  const doc = newDoc('内部QRラベル');
  const cols = 3;
  const rows = 8;
  const marginX = mm(7);
  const marginY = mm(10);
  const w = (doc.page.width - marginX * 2) / cols;
  const h = (doc.page.height - marginY * 2) / rows;
  const qrSize = Math.min(h - mm(4), mm(26));
  for (let i = 0; i < items.length; i++) {
    const slot = i % (cols * rows);
    if (i > 0 && slot === 0) doc.addPage();
    const cx = marginX + (slot % cols) * w;
    const cy = marginY + Math.floor(slot / cols) * h;
    // 切り取り目安の薄い枠
    doc.rect(cx, cy, w, h).lineWidth(0.3).strokeColor('#cccccc').stroke();
    const it = items[i];
    // QR はクワイエットゾーン4モジュールを含めて生成
    const png = await QRCode.toBuffer(it.payload, { errorCorrectionLevel: 'M', margin: 4, scale: 8 });
    doc.image(png, cx + mm(2), cy + (h - qrSize) / 2, { width: qrSize, height: qrSize });
    const tx = cx + mm(2) + qrSize + mm(1.5);
    const tw = w - (tx - cx) - mm(2);
    doc.fillColor('#000').font('jpb').fontSize(9).text(it.title, tx, cy + mm(4), { width: tw, height: mm(9), ellipsis: true });
    doc.font('jp').fontSize(7.5).text(it.subtitle, tx, doc.y + 1, { width: tw, height: mm(14), ellipsis: true });
    if (it.note) doc.fontSize(6.5).fillColor('#333').text(it.note, tx, cy + h - mm(7), { width: tw, height: mm(5), ellipsis: true, lineBreak: false });
    doc.fillColor('#000');
  }
  if (items.length === 0) doc.fontSize(12).text('ラベル対象がありません');
  return toBuffer(doc);
}
