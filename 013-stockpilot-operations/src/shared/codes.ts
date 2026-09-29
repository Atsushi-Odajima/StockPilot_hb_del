// SKU・場所・仕入先コードの比較キー、JAN/EAN 検証、内部QRの書式。

/** 比較キー：前後空白を除き、大小文字の違いを同一視する。原文は別に保持する。 */
export function codeKey(code: string): string {
  return code.trim().normalize('NFKC').toLowerCase();
}

export type BarcodeKind = 'JAN13' | 'EAN8' | 'CODE128' | 'OTHER';

function gtinCheckDigitOk(digits: string): boolean {
  // GTIN 共通：右端をチェックデジットとし、その左から 3,1,3,1… の重み
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const n = body.charCodeAt(body.length - 1 - i) - 48;
    sum += n * (i % 2 === 0 ? 3 : 1);
  }
  const check = (10 - (sum % 10)) % 10;
  return check === digits.charCodeAt(digits.length - 1) - 48;
}

export interface CodeValidation {
  ok: boolean;
  message?: string;
}

/** 関連コードの検証。JAN/EAN は桁とチェックデジットを確認する（文字列で扱い先頭ゼロを保持）。 */
export function validateBarcode(code: string, kind: BarcodeKind): CodeValidation {
  if (code !== code.trim() || code.length === 0) return { ok: false, message: 'コードの前後に空白があります' };
  if (code.length > 60) return { ok: false, message: 'コードが長すぎます（60文字まで）' };
  if (kind === 'JAN13') {
    if (!/^\d{13}$/.test(code)) return { ok: false, message: 'JAN/EAN-13 は数字13桁です' };
    if (!gtinCheckDigitOk(code)) return { ok: false, message: 'JAN/EAN-13 のチェックデジットが一致しません' };
  } else if (kind === 'EAN8') {
    if (!/^\d{8}$/.test(code)) return { ok: false, message: 'EAN-8 は数字8桁です' };
    if (!gtinCheckDigitOk(code)) return { ok: false, message: 'EAN-8 のチェックデジットが一致しません' };
  } else if (kind === 'CODE128') {
    if (!/^[\x20-\x7e]+$/.test(code)) return { ok: false, message: 'Code128 は半角英数記号のみです' };
  } else {
    if (/[\u0000-\u001f]/.test(code)) return { ok: false, message: '制御文字は使えません' };
  }
  return { ok: true };
}

export function computeGtinCheckDigit(bodyDigits: string): string {
  let sum = 0;
  for (let i = 0; i < bodyDigits.length; i++) {
    const n = bodyDigits.charCodeAt(bodyDigits.length - 1 - i) - 48;
    sum += n * (i % 2 === 0 ? 3 : 1);
  }
  return String((10 - (sum % 10)) % 10);
}

// 内部QR：SP:1:SKU:<uuid> / SP:1:LOC:<uuid>。認証情報ではなく、ログイン中の事業者内でのみ解決する。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type InternalQr = { type: 'SKU' | 'LOC'; id: string };

export function internalQrPayload(type: 'SKU' | 'LOC', id: string): string {
  return `SP:1:${type}:${id}`;
}

export function parseInternalQr(text: string): InternalQr | null {
  const m = /^SP:1:(SKU|LOC):(.+)$/.exec(text.trim());
  if (!m) return null;
  const id = m[2].toLowerCase();
  if (!UUID_RE.test(id)) return null;
  return { type: m[1] as 'SKU' | 'LOC', id };
}

export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** スキャン文字列の種類を推定（表示用）。URL は自動で開かない。 */
export function classifyScan(text: string): 'internal' | 'gtin' | 'url' | 'other' {
  if (parseInternalQr(text)) return 'internal';
  if (/^\d{8}$|^\d{13}$/.test(text)) return 'gtin';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return 'url';
  return 'other';
}
