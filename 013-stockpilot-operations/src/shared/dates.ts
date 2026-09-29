// 業務日付は YYYY-MM-DD 文字列で扱い、基準タイムゾーンは Asia/Tokyo。
// Date オブジェクトへの変換で UTC 日付にずれないよう、文字列演算で処理する。

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** Asia/Tokyo の今日（テストでは now を固定して渡す） */
export function tokyoToday(now: Date = new Date()): string {
  // JST は夏時間なしの UTC+9 固定
  const t = new Date(now.getTime() + 9 * 3600 * 1000);
  return t.toISOString().slice(0, 10);
}

/** カレンダー日加算（休日・稼働日は考慮しない） */
export function addDays(date: string, days: number): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error('invalid date');
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  const pa = DATE_RE.exec(a)!;
  const pb = DATE_RE.exec(b)!;
  const ta = Date.UTC(Number(pa[1]), Number(pa[2]) - 1, Number(pa[3]));
  const tb = Date.UTC(Number(pb[1]), Number(pb[2]) - 1, Number(pb[3]));
  return Math.round((ta - tb) / 86400000);
}

/** 表示用 Asia/Tokyo 日時 */
export function formatTokyoDateTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const t = new Date(d.getTime() + 9 * 3600 * 1000).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 16)}`;
}
