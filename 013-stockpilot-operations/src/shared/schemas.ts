import { z } from 'zod';
import { MAX_OP_QTY, MAX_BALANCE } from './limits.js';
import { isValidDate } from './dates.js';

// サーバー入力スキーマ（クライアントも同じ定義を使う）
export const zUuid = z.string().uuid();
export const zDate = z.string().refine(isValidDate, '日付は YYYY-MM-DD 形式の実在日です');
export const zOpQty = z.number().int('数量は整数です').min(1, '数量は1以上です').max(MAX_OP_QTY, `数量は${MAX_OP_QTY.toLocaleString()}以下です`);
export const zCount = z.number().int('数量は整数です').min(0, '数量は0以上です').max(MAX_BALANCE);
export const zIdemKey = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, '操作キーが不正です');
export const zText = (max: number) => z.string().max(max, `${max}文字以内で入力してください`);
export const zReq = (max: number) => z.string().trim().min(1, '必須項目です').max(max, `${max}文字以内で入力してください`);
const zCode = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim().length > 0, 'コードは必須です')
    .refine((s) => !/[\u0000-\u001f]/.test(s), '制御文字は使えません');

export const zSupplierInput = z.object({
  code: zCode(40),
  name: zReq(100),
  contactName: zText(100).default(''),
  contact: zText(300).default(''),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().default(null),
  note: zText(2000).default(''),
});
export type SupplierInput = z.infer<typeof zSupplierInput>;

export const zLocationInput = z.object({
  code: zCode(40),
  name: zReq(100),
  description: zText(500).default(''),
  kind: z.enum(['normal', 'hold']),
});
export type LocationInput = z.infer<typeof zLocationInput>;

export const zReplenishSettings = z.object({
  safetyStock: z.number().int().min(0).max(MAX_BALANCE),
  reorderPoint: z.number().int().min(0).max(MAX_BALANCE),
  targetStock: z.number().int().min(1).max(MAX_BALANCE),
  minOrderQty: z.number().int().min(0).max(MAX_OP_QTY),
  orderMultiple: z.number().int().min(1).max(MAX_OP_QTY),
});

export const zSkuInput = z.object({
  code: zCode(60),
  name: zReq(200),
  groupName: zText(200).default(''),
  color: zText(60).default(''),
  size: zText(60).default(''),
  attrs: zText(200).default(''),
  category: zText(100).default(''),
  brand: zText(100).default(''),
  unit: zReq(10).default('個'),
  supplierId: zUuid.nullable().default(null),
  memo: zText(2000).default(''),
  replenish: zReplenishSettings.nullable().default(null),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().default(null),
});
export type SkuInput = z.infer<typeof zSkuInput>;

export const zBarcodeInput = z.object({
  code: z.string().min(1).max(60),
  kind: z.enum(['JAN13', 'EAN8', 'CODE128', 'OTHER']),
});

const zCommon = {
  idempotencyKey: zIdemKey,
  businessDate: zDate,
  note: zText(1000).default(''),
};

// 画面に表示していた数量（古い画面からの確定検出用）
export const zExpected = z.array(z.object({ skuId: zUuid, locationId: zUuid, qty: zCount })).max(400).default([]);

export const zInitialStockCmd = z.object({
  ...zCommon,
  lines: z.array(z.object({ skuId: zUuid, locationId: zUuid, qty: zOpQty })).min(1).max(200),
});

export const zOutsideReceiptCmd = z.object({
  ...zCommon,
  reason: zReq(500),
  externalRef: zText(100).default(''),
  lines: z.array(z.object({ skuId: zUuid, locationId: zUuid, qty: zOpQty })).min(1).max(200),
  expected: zExpected,
});

export const zIssueCmd = z.object({
  ...zCommon,
  purpose: z.enum(['sale', 'sample', 'business_use', 'other']),
  externalRef: zText(100).default(''),
  destinationLabel: zText(100).default(''),
  lines: z.array(z.object({ skuId: zUuid, locationId: zUuid, qty: zOpQty })).min(1).max(200),
  expected: zExpected,
});

export const zTransferCmd = z.object({
  ...zCommon,
  fromLocationId: zUuid,
  toLocationId: zUuid,
  reason: zText(500).default(''),
  lines: z.array(z.object({ skuId: zUuid, qty: zOpQty })).min(1).max(200),
  expected: zExpected,
});

export const zDisposalCmd = z.object({
  ...zCommon,
  reason: zReq(500),
  lines: z.array(z.object({ skuId: zUuid, locationId: zUuid, qty: zOpQty })).min(1).max(200),
  expected: zExpected,
});

export const zCorrectionCmd = z.object({
  ...zCommon,
  reason: zReq(500),
  lines: z
    .array(z.object({ skuId: zUuid, locationId: zUuid, direction: z.enum(['increase', 'decrease']), qty: zOpQty }))
    .min(1)
    .max(200),
  expected: zExpected,
});

export const zCustomerReturnCmd = z.object({
  ...zCommon,
  // 元の出庫イベント。null なら元履歴なし返品（理由必須）
  sourceEventId: zUuid.nullable(),
  skuId: zUuid,
  locationId: zUuid, // 保留場所
  qty: zOpQty,
  reason: zText(500).default(''),
  externalRef: zText(100).default(''),
});

export const zSupplierReturnCmd = z.object({
  ...zCommon,
  sourceEventId: zUuid, // 元の受領イベント
  locationId: zUuid, // 現物を返す場所
  qty: zOpQty,
  reason: zReq(500),
  externalRef: zText(100).default(''),
  expected: zExpected,
});

export const zReversalCmd = z.object({
  ...zCommon,
  eventId: zUuid,
  qty: zOpQty,
  reason: zReq(500),
});

// 発注
export const zPoLineInput = z.object({
  id: zUuid.optional(),
  skuId: zUuid,
  qty: zOpQty,
  dueDate: zDate.nullable().default(null),
  locationId: zUuid,
  basisP: z.number().int().nullable().optional(),
});
export const zPoDraftInput = z.object({
  supplierId: zUuid,
  dueDate: zDate.nullable().default(null),
  locationId: zUuid.nullable().default(null),
  externalRef: zText(100).default(''),
  supplierNote: zText(1000).default(''),
  internalMemo: zText(2000).default(''),
  replacesPoId: zUuid.nullable().default(null),
  lines: z.array(zPoLineInput).max(200),
});
export type PoDraftInput = z.infer<typeof zPoDraftInput>;

export const zPoPlaceCmd = z.object({
  idempotencyKey: zIdemKey,
  version: z.number().int(),
  orderedDate: zDate,
  // 補充候補の再確認：SKUごとに画面で見ていた補充判断数量 P
  acknowledgedBasis: z.record(z.string(), z.number().int()).default({}),
});

export const zPoReviseCmd = z.object({
  idempotencyKey: zIdemKey,
  version: z.number().int(),
  reason: zReq(500),
  dueDate: zDate.nullable(),
  externalRef: zText(100),
  supplierNote: zText(1000),
  internalMemo: zText(2000),
  lines: z.array(zPoLineInput).min(1).max(200),
});

export const zPoCancelRemainingCmd = z.object({
  idempotencyKey: zIdemKey,
  version: z.number().int(),
  reason: zReq(500),
  lineIds: z.array(zUuid).min(1).max(200),
});

export const zReceiptCmd = z.object({
  idempotencyKey: zIdemKey,
  businessDate: zDate,
  note: zText(1000).default(''),
  lines: z
    .array(
      z.object({
        poLineId: zUuid,
        splits: z.array(z.object({ locationId: zUuid, qty: zOpQty })).min(1).max(20),
      }),
    )
    .min(1)
    .max(200),
  // 不足受領の扱い：明細IDごとに「残りを打ち切る」場合に指定
  closeShortLineIds: z.array(zUuid).default([]),
  closeShortReason: zText(500).default(''),
  expected: zExpected,
});

// 棚卸
export const zStocktakeStartCmd = z.object({ idempotencyKey: zIdemKey, locationId: zUuid, businessDate: zDate });
export const zStocktakeCountInput = z.object({
  lineId: zUuid,
  version: z.number().int(),
  countedQty: zCount.nullable(),
});
export const zStocktakeReasonInput = z.object({
  lineId: zUuid,
  version: z.number().int(),
  reasonCode: z.enum(['miscount', 'unrecorded_in', 'unrecorded_out', 'damage', 'loss', 'found', 'other']).nullable(),
  reasonNote: zText(500),
});
export const zStocktakeConfirmCmd = z.object({ idempotencyKey: zIdemKey, version: z.number().int() });
export const zStocktakeCancelCmd = z.object({
  idempotencyKey: zIdemKey,
  reason: zReq(500),
  outsideMovementNote: zText(1000).default(''),
});

export const STOCKTAKE_REASONS: Record<string, string> = {
  miscount: '過去の数え間違い',
  unrecorded_in: '入庫の記録漏れ',
  unrecorded_out: '出庫の記録漏れ',
  damage: '破損・劣化',
  loss: '紛失・不明',
  found: '見つかった',
  other: 'その他',
};

export const PURPOSE_LABEL: Record<string, string> = {
  sale: '販売',
  sample: 'サンプル配布',
  business_use: '業務使用',
  other: 'その他',
};
