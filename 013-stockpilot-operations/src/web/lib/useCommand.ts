import { useCallback, useRef, useState } from 'react';
import { ApiError, NetworkError, lookupKey, newKey, post } from './api';

export type CmdState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'done'; result: any; replayed: boolean }
  | { phase: 'error'; error: ApiError }
  | { phase: 'unknown'; message: string } // 結果確認中（届いたか不明）
  | { phase: 'checking' };

/**
 * 確定コマンドの送信。
 * - 同じ操作は同じ idempotencyKey で送る（再送しても二重反映しない）。
 * - サーバーが拒否した（＝反映されていない）場合は、次の送信で新しいキーを使う。
 * - 結果不明なら、まず同じキーの処理状況を照会する。新しいキーで即再実行しない。
 */
export function useCommand(url: string, initialKey?: string) {
  const keyRef = useRef(initialKey ?? newKey());
  const lastBody = useRef<any>(null);
  const [state, setState] = useState<CmdState>({ phase: 'idle' });

  const submit = useCallback(
    async (body: any) => {
      if (state.phase === 'sending' || state.phase === 'checking') return null;
      if (state.phase === 'unknown') return null; // 照会が先
      setState({ phase: 'sending' });
      const payload = { ...body, idempotencyKey: keyRef.current };
      lastBody.current = payload;
      try {
        const r = await post(url, payload);
        setState({ phase: 'done', result: r.result ?? r, replayed: !!r.replayed });
        return r;
      } catch (e) {
        if (e instanceof NetworkError) {
          setState({ phase: 'unknown', message: e.message });
        } else if (e instanceof ApiError) {
          keyRef.current = newKey();
          setState({ phase: 'error', error: e });
        } else {
          setState({ phase: 'unknown', message: '処理結果を確認できませんでした' });
        }
        return null;
      }
    },
    [url, state.phase],
  );

  /** 結果不明の操作を照会し、未処理なら同じキー・同じ内容で再送できる状態に戻す */
  const check = useCallback(async () => {
    setState({ phase: 'checking' });
    try {
      const r = await lookupKey(keyRef.current);
      if (r.found) {
        setState({ phase: 'done', result: r.result, replayed: true });
        return 'done';
      }
      setState({ phase: 'idle' });
      return 'not_found';
    } catch (e) {
      setState({ phase: 'unknown', message: e instanceof Error ? e.message : '確認できませんでした' });
      return 'unknown';
    }
  }, []);

  /** 同じキーで同じ内容を再送（結果不明の後に未処理と確認できた場合） */
  const resend = useCallback(async () => {
    if (!lastBody.current) return null;
    setState({ phase: 'sending' });
    try {
      const r = await post(url, lastBody.current);
      setState({ phase: 'done', result: r.result ?? r, replayed: !!r.replayed });
      return r;
    } catch (e) {
      if (e instanceof ApiError) {
        keyRef.current = newKey();
        setState({ phase: 'error', error: e });
      } else setState({ phase: 'unknown', message: (e as Error).message });
      return null;
    }
  }, [url]);

  const reset = useCallback(() => {
    keyRef.current = newKey();
    lastBody.current = null;
    setState({ phase: 'idle' });
  }, []);

  return { state, submit, check, resend, reset, key: () => keyRef.current, setKey: (k: string) => (keyRef.current = k) };
}
