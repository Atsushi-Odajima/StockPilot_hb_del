// 補充計算（INVENTORY_RULES.md §補充）
// U = 通常場所の利用可能在庫合計、O = 通常場所へ入る有効な発注残合計、P = U + O（補充判断数量。現物在庫ではない）

export interface ReplenishSettings {
  safetyStock: number;
  reorderPoint: number;
  targetStock: number;
  minOrderQty: number;
  orderMultiple: number;
}

export interface ReplenishInput {
  available: number; // U
  onOrder: number; // O
  settings: ReplenishSettings | null;
}

export interface ReplenishResult {
  configured: boolean;
  p: number;
  belowSafety: boolean; // U < 安全在庫（手元不足）
  atOrBelowReorder: boolean; // P <= 発注点
  need: number;
  recommended: number;
  reason: string;
}

export function validateReplenishSettings(s: ReplenishSettings): string | null {
  const ints = [s.safetyStock, s.reorderPoint, s.targetStock, s.minOrderQty, s.orderMultiple];
  if (!ints.every((n) => Number.isSafeInteger(n))) return '補充設定は整数で入力してください';
  if (s.safetyStock < 0) return '安全在庫は0以上です';
  if (s.safetyStock > s.reorderPoint) return '安全在庫は発注点以下にしてください';
  if (s.reorderPoint >= s.targetStock) return '目標在庫は発注点より大きくしてください';
  if (s.orderMultiple < 1) return '発注単位は1以上です';
  if (s.minOrderQty < 0) return '最小発注数量は0以上です';
  return null;
}

export function computeReplenishment(input: ReplenishInput): ReplenishResult {
  const { available: u, onOrder: o, settings } = input;
  const p = u + o;
  if (!settings) {
    return { configured: false, p, belowSafety: false, atOrBelowReorder: false, need: 0, recommended: 0, reason: '補充設定なし' };
  }
  const belowSafety = u < settings.safetyStock;
  const atOrBelowReorder = p <= settings.reorderPoint;
  let need = 0;
  let recommended = 0;
  if (atOrBelowReorder) {
    need = Math.max(0, settings.targetStock - p);
    if (need > 0) {
      const base = Math.max(need, settings.minOrderQty);
      recommended = Math.ceil(base / settings.orderMultiple) * settings.orderMultiple;
    }
  }
  let reason: string;
  if (recommended > 0) {
    reason = `補充判断数量${p}が発注点${settings.reorderPoint}以下（目標${settings.targetStock}まで${need}不足）`;
  } else if (belowSafety && o > 0) {
    reason = `手元不足・${o}入荷待ち`;
  } else if (belowSafety) {
    reason = '安全在庫割れ';
  } else {
    reason = '補充不要';
  }
  return { configured: true, p, belowSafety, atOrBelowReorder, need, recommended, reason };
}
