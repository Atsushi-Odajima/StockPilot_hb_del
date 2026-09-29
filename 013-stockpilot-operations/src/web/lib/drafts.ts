// 端末下書き（IndexedDB）。サーバー在庫の代わりではなく、未送信の入力を一時的に残すだけ。
// 端末保存はバックアップではない：ブラウザの判断で削除されることがある（WebKit のストレージ方針）。

export interface DeviceDraft {
  id: string; // 操作UUID＝送信時の idempotencyKey
  account: string; // 事業者＋メール（別アカウントへ見せない）
  dataEpoch: string; // 作成時のデータ世代
  kind: 'issue' | 'transfer' | 'outside-receipt' | 'receive' | 'disposal';
  title: string;
  payload: any; // フォームの入力内容
  basis: { skuId: string; locationId: string; qty: number }[]; // 下書き時点で表示していた数量
  savedAt: string;
  status: 'draft' | 'unknown'; // unknown = 送信したが結果不明
}

const DB = 'stockpilot-drafts';
const STORE = 'drafts';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('account', 'account');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDraft(d: DeviceDraft) {
  try {
    await tx('readwrite', (s) => s.put(d));
    return true;
  } catch {
    return false; // 容量不足・プライベートモード等
  }
}
export async function listDrafts(account: string): Promise<DeviceDraft[]> {
  try {
    const all = (await tx('readonly', (s) => s.index('account').getAll(account))) as DeviceDraft[];
    return all.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  } catch {
    return [];
  }
}
export async function getDraft(id: string): Promise<DeviceDraft | undefined> {
  try {
    return (await tx('readonly', (s) => s.get(id))) as DeviceDraft | undefined;
  } catch {
    return undefined;
  }
}
export async function removeDraft(id: string) {
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch {
    /* noop */
  }
}
export async function removeAllDrafts(account: string) {
  const ds = await listDrafts(account);
  for (const d of ds) await removeDraft(d.id);
  return ds.length;
}
export async function countDrafts(account: string) {
  return (await listDrafts(account)).length;
}
