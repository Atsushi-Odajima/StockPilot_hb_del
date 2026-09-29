// 数量・件数の上限。計算・CSV・DB制約と一致させること（migrations/0001_init.sql）。
export const MAX_OP_QTY = 1_000_000; // 1操作（1明細）あたりの上限
export const MAX_BALANCE = 1_000_000_000; // SKU×場所の残高上限
export const MAX_LINES_PER_OP = 200; // 1伝票の明細数
export const CSV_MAX_MASTER_ROWS = 5_000;
export const CSV_MAX_QTY_ROWS = 2_000;
export const CSV_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const BACKUP_MAX_BYTES = 500 * 1024 * 1024;
export const BACKUP_MAX_FILES = 20_000;
export const PAGE_SIZE_MAX = 200;

/** 正の整数の入出庫数量として有効か（NaN・小数・負数・上限超過を拒否） */
export function isValidOpQty(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= MAX_OP_QTY;
}

/** 0以上の整数（棚卸実数等）として有効か */
export function isValidCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_BALANCE;
}

/** 文字列入力を厳格に整数へ。"12" → 12、"1.0"・"1e3"・" 12 x" → null */
export function parseStrictInt(s: string): number | null {
  const t = s.trim();
  if (!/^[-+]?\d{1,12}$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}
