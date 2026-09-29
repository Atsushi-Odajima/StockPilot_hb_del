// API エラー。code は API_CONTRACTS.md に列挙。message は利用者向け日本語。

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'ENTITLEMENT_REQUIRED'
  | 'CSRF'
  | 'RATE_LIMITED'
  | 'EPOCH_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'STALE_QTY'
  | 'INSUFFICIENT_STOCK'
  | 'BALANCE_LIMIT'
  | 'LOCATION_LOCKED'
  | 'OVER_RECEIPT'
  | 'OVER_CAP'
  | 'DUPLICATE'
  | 'IN_USE'
  | 'STATE'
  | 'BASIS_CHANGED'
  | 'INITIAL_EXISTS'
  | 'IMPORT_DUPLICATE'
  | 'TOO_LARGE'
  | 'RESTORE_INVALID'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  ENTITLEMENT_REQUIRED: 403,
  CSRF: 403,
  RATE_LIMITED: 429,
  EPOCH_MISMATCH: 409,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  STALE_QTY: 409,
  INSUFFICIENT_STOCK: 422,
  BALANCE_LIMIT: 422,
  LOCATION_LOCKED: 423,
  OVER_RECEIPT: 422,
  OVER_CAP: 422,
  DUPLICATE: 409,
  IN_USE: 409,
  STATE: 409,
  BASIS_CHANGED: 409,
  INITIAL_EXISTS: 409,
  IMPORT_DUPLICATE: 409,
  TOO_LARGE: 413,
  RESTORE_INVALID: 422,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export const fail = (code: ErrorCode, message: string, details?: unknown): never => {
  throw new AppError(code, message, details);
};
