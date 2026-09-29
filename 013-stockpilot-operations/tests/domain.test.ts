import { describe, expect, it } from 'vitest';
import { validateBarcode, codeKey, parseInternalQr, internalQrPayload, classifyScan } from '../src/shared/codes.js';
import { isValidDate, addDays, tokyoToday, diffDays } from '../src/shared/dates.js';
import { poDisplayStatus, outstanding, lineInvariantOk } from '../src/domain/po.js';
import { parseStrictInt, isValidOpQty } from '../src/shared/limits.js';

describe('コード', () => {
  it('JAN/EAN-13・EAN-8 の桁とチェックデジット、先頭ゼロ', () => {
    expect(validateBarcode('4901234567894', 'JAN13').ok).toBe(true);
    expect(validateBarcode('4901234567895', 'JAN13').ok).toBe(false);
    expect(validateBarcode('0012345678905', 'JAN13').ok).toBe(true);
    expect(validateBarcode('490123456789', 'JAN13').ok).toBe(false);
    expect(validateBarcode('96385074', 'EAN8').ok).toBe(true);
    expect(validateBarcode('96385075', 'EAN8').ok).toBe(false);
    expect(validateBarcode(' 4901234567894', 'JAN13').ok).toBe(false);
  });
  it('比較キーは前後空白と大小文字を同一視', () => {
    expect(codeKey(' Ab-01 ')).toBe(codeKey('aB-01'));
    expect(codeKey('00123')).not.toBe(codeKey('0123'));
  });
  it('内部QR：用途と版を区別し、URLは自動で開かない', () => {
    const id = crypto.randomUUID();
    expect(parseInternalQr(internalQrPayload('SKU', id))).toEqual({ type: 'SKU', id });
    expect(parseInternalQr(`SP:2:SKU:${id}`)).toBeNull();
    expect(parseInternalQr('SP:1:SKU:not-a-uuid')).toBeNull();
    expect(classifyScan('https://evil.example/')).toBe('url');
  });
});

describe('日付（Asia/Tokyo・うるう年・月末）', () => {
  it('実在日のみ', () => {
    expect(isValidDate('2028-02-29')).toBe(true);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2100-02-29')).toBe(false);
    expect(isValidDate('2026-04-31')).toBe(false);
  });
  it('UTCへの不要な変換で日付がずれない', () => {
    expect(tokyoToday(new Date('2026-03-31T14:59:59Z'))).toBe('2026-03-31');
    expect(tokyoToday(new Date('2026-03-31T15:00:00Z'))).toBe('2026-04-01');
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(diffDays('2026-03-01', '2026-02-28')).toBe(1);
  });
});

describe('発注の数量と状態', () => {
  it('O=Q-R-C と状態', () => {
    expect(outstanding({ qty: 100, received: 60, cancelled: 40 })).toBe(0);
    expect(poDisplayStatus('placed', [{ qty: 100, received: 60, cancelled: 40 }])).toBe('closed_short');
    expect(poDisplayStatus('placed', [{ qty: 100, received: 100, cancelled: 0 }])).toBe('received');
    expect(poDisplayStatus('placed', [{ qty: 100, received: 0, cancelled: 100 }])).toBe('cancelled');
    expect(poDisplayStatus('placed', [{ qty: 100, received: 10, cancelled: 0 }])).toBe('partial');
    expect(poDisplayStatus('placed', [{ qty: 100, received: 0, cancelled: 0 }])).toBe('ordered');
    expect(poDisplayStatus('draft', [{ qty: 100, received: 0, cancelled: 0 }])).toBe('draft');
    expect(lineInvariantOk({ qty: 10, received: 6, cancelled: 5 })).toBe(false);
  });
});

describe('数量入力', () => {
  it('厳格な整数', () => {
    expect(parseStrictInt('12')).toBe(12);
    for (const s of ['1.0', '1e3', '12x', '', '０']) expect(parseStrictInt(s)).toBeNull();
    expect(isValidOpQty(1_000_000)).toBe(true);
    expect(isValidOpQty(1_000_001)).toBe(false);
  });
});
