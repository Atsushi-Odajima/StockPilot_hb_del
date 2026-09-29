// サーバーAPIの呼び出し。CSRFヘッダーとデータ世代（dataEpoch）を必ず付ける。
// 通信成功はサーバー応答を受け取れたかで判断する（navigator.onLine だけでは判断しない）。

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

/** サーバーに届いたか分からない（結果不明） */
export class NetworkError extends Error {
  constructor(message = '通信できませんでした。電波の良い場所で、処理状況を確認してください。') {
    super(message);
  }
}

let dataEpoch = '';
const listeners = new Set<(e: { type: 'epoch' | 'auth' | 'online'; value?: any }) => void>();
export const onApiEvent = (fn: (e: { type: 'epoch' | 'auth' | 'online'; value?: any }) => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit = (e: { type: 'epoch' | 'auth' | 'online'; value?: any }) => listeners.forEach((l) => l(e));

export function setEpoch(e: string) {
  dataEpoch = e;
}
export function getEpoch() {
  return dataEpoch;
}

let lastOk = 0;
export const lastServerContact = () => lastOk;

export async function api<T = any>(method: string, url: string, body?: unknown, opts: { raw?: boolean; timeoutMs?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-stockpilot-csrf': '1' };
  if (dataEpoch) headers['x-data-epoch'] = dataEpoch;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', signal: ctrl.signal, cache: 'no-store' });
  } catch {
    emit({ type: 'online', value: false });
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }
  lastOk = Date.now();
  emit({ type: 'online', value: true });
  if (res.status >= 500 && res.status !== 500) throw new NetworkError('サーバーに接続できませんでした（' + res.status + '）。処理状況を確認してください。');
  if (!res.ok) {
    let err: any = {};
    try {
      err = (await res.json()).error ?? {};
    } catch {
      /* 本文なし */
    }
    if (res.status === 401) emit({ type: 'auth' });
    if (err.code === 'EPOCH_MISMATCH') emit({ type: 'epoch', value: err.details?.currentEpoch });
    if (res.status === 500) throw new NetworkError(err.message ?? 'サーバーで問題が発生しました。処理状況を確認してください。');
    throw new ApiError(res.status, err.code ?? 'ERROR', err.message ?? `エラー（${res.status}）`, err.details);
  }
  if (opts.raw) return res as unknown as T;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('json') ? res.json() : res.text()) as Promise<T>;
}

export const get = <T = any>(url: string) => api<T>('GET', url);
export const post = <T = any>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});
export const put = <T = any>(url: string, body?: unknown) => api<T>('PUT', url, body ?? {});
export const del = <T = any>(url: string) => api<T>('DELETE', url);

export function qs(params: Record<string, unknown>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) s.set(k, String(v));
  const t = s.toString();
  return t ? `?${t}` : '';
}

export const newKey = () => crypto.randomUUID();

/** 結果不明時の照会：同じ操作キーで処理済みか確認する */
export async function lookupKey(key: string): Promise<{ found: boolean; result?: any }> {
  return get(`/api/ops/by-key/${key}`);
}

export async function fetchBlob(url: string): Promise<Blob> {
  const res = await api<Response>('GET', url, undefined, { raw: true, timeoutMs: 120_000 });
  return res.blob();
}
