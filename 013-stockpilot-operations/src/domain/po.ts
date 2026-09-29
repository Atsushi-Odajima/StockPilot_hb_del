// 発注明細の数量と状態（INVENTORY_RULES.md §発注）
// Q=発注数量、R=有効な実入荷累計、C=未入荷打切り、O=Q-R-C（発注残）

export interface PoLineQty {
  qty: number; // Q
  received: number; // R
  cancelled: number; // C
}

export function outstanding(l: PoLineQty): number {
  return l.qty - l.received - l.cancelled;
}

export function lineInvariantOk(l: PoLineQty): boolean {
  return (
    Number.isSafeInteger(l.qty) &&
    Number.isSafeInteger(l.received) &&
    Number.isSafeInteger(l.cancelled) &&
    l.qty >= 0 &&
    l.received >= 0 &&
    l.cancelled >= 0 &&
    l.received + l.cancelled <= l.qty
  );
}

export type PoDisplayStatus = 'draft' | 'ordered' | 'partial' | 'received' | 'closed_short' | 'cancelled';

export const PO_STATUS_LABEL: Record<PoDisplayStatus, string> = {
  draft: '下書き',
  ordered: '発注済み',
  partial: '一部入荷',
  received: '入荷完了',
  closed_short: '残数打切り完了',
  cancelled: '取消',
};

/** 明細の数量から状態を導く（保存された状態と矛盾させない） */
export function poDisplayStatus(status: 'draft' | 'placed', lines: PoLineQty[]): PoDisplayStatus {
  if (status === 'draft') return 'draft';
  const Q = lines.reduce((a, l) => a + l.qty, 0);
  const R = lines.reduce((a, l) => a + l.received, 0);
  const C = lines.reduce((a, l) => a + l.cancelled, 0);
  const O = Q - R - C;
  if (O > 0) return R > 0 ? 'partial' : 'ordered';
  if (R === 0) return 'cancelled';
  if (C === 0) return 'received';
  return 'closed_short';
}

export function lineDisplayStatus(l: PoLineQty): PoDisplayStatus {
  return poDisplayStatus('placed', [l]);
}
