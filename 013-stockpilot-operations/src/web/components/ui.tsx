import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, get, qs, NetworkError } from '../lib/api';
import type { CmdState } from '../lib/useCommand';
import { Scanner } from './Scanner';

export function useFetch<T>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!!url);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!url) return;
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const d = await get<T>(url);
      if (my === seq.current) setData(d);
    } catch (e) {
      if (my === seq.current) setError(e as Error);
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(() => {
    load();
  }, [load]);
  // 画面復帰時に再取得（PCで確定した在庫をスマホで反映）
  useEffect(() => {
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

export function Loading({ text = '読み込み中…' }: { text?: string }) {
  return (
    <p className="loading" role="status">
      {text}
    </p>
  );
}

export function ErrorMsg({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as Error;
  let text = e.message;
  if (e instanceof ApiError && e.status === 403 && e.code === 'ENTITLEMENT_REQUIRED') text = e.message;
  if (e instanceof NetworkError) text = e.message;
  return (
    <div className="msg msg-error" role="alert">
      {text}
      {e instanceof ApiError && e.code === 'INSUFFICIENT_STOCK' && e.details?.shortages?.[0]?.otherLocations?.length > 0 && (
        <div className="small">
          他の場所の在庫：
          {e.details.shortages[0].otherLocations.map((o: any) => `${o.name}${o.kind === 'hold' ? '（保留）' : ''} ${o.qty}`).join('、')}
          （自動で他の場所から減らしません）
        </div>
      )}
      {e instanceof ApiError && e.code === 'STALE_QTY' && (
        <div className="small">最新の数量：{e.details?.stale?.map((s: any) => s.current).join('、')}。内容を確認して、もう一度確定してください。</div>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Photo({ fileId, large, alt }: { fileId?: string | null; large?: boolean; alt: string }) {
  if (!fileId) return <div className={`thumb ${large ? 'thumb-lg' : ''}`}>写真なし</div>;
  return <img className={`thumb ${large ? 'thumb-lg' : ''}`} src={`/api/files/${fileId}`} alt={alt} loading="lazy" />;
}

export function variant(color?: string, size?: string) {
  return [color, size].filter(Boolean).join(' / ');
}

export function KindBadge({ kind }: { kind: 'normal' | 'hold' | string }) {
  return kind === 'hold' ? <span className="badge badge-hold">保留</span> : <span className="badge">通常</span>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

/** 正の整数だけを受け付ける数量入力。空欄と0を区別する（空欄は null） */
export function QtyInput({
  value,
  onChange,
  label,
  unit,
  min = 1,
  max = 1_000_000,
  allowZero,
  id,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  label: string;
  unit?: string;
  min?: number;
  max?: number;
  allowZero?: boolean;
  id?: string;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => {
    setText(value === null ? '' : String(value));
  }, [value]);
  const lo = allowZero ? 0 : min;
  const n = text === '' ? null : /^\d{1,10}$/.test(text) ? Number(text) : NaN;
  const invalid = n !== null && (Number.isNaN(n) || n < lo || n > max);
  return (
    <label className="field">
      <span>
        {label}
        {unit ? `（${unit}）` : ''}
      </span>
      <div className="row" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
        <button type="button" className="btn" style={{ flex: '0 0 48px' }} aria-label="1減らす" onClick={() => onChange(Math.max(lo, (n && !Number.isNaN(n) ? n : lo + 1) - 1))}>
          −
        </button>
        <input
          id={id}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          value={text}
          aria-invalid={invalid}
          onChange={(e) => {
            const t = e.target.value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
            setText(t);
            if (t === '') onChange(null);
            else if (/^\d{1,10}$/.test(t) && Number(t) >= lo && Number(t) <= max) onChange(Number(t));
            else onChange(null);
          }}
          style={{ textAlign: 'right', fontSize: '1.3rem', fontWeight: 700 }}
        />
        <button type="button" className="btn" style={{ flex: '0 0 48px' }} aria-label="1増やす" onClick={() => onChange(Math.min(max, (n && !Number.isNaN(n) ? n : lo - 1) + 1))}>
          ＋
        </button>
      </div>
      {invalid && (
        <small className="minus">
          {lo}〜{max.toLocaleString()}の整数で入力してください（小数・負数は使えません）
        </small>
      )}
    </label>
  );
}

export function ChangePreview({ before, delta, unit, label }: { before: number; delta: number; unit: string; label?: string }) {
  const after = before + delta;
  return (
    <div className="change" aria-label={`${label ?? ''} 現在${before}${unit}、${delta >= 0 ? '増加' : '減少'}${Math.abs(delta)}${unit}、確定後${after}${unit}`}>
      {label && <div style={{ width: '100%', fontWeight: 700 }}>{label}</div>}
      <div className="part">
        <div className="label">現在</div>
        <div className="qtybig">
          {before}
          <small>{unit}</small>
        </div>
      </div>
      <div className="arrow">→</div>
      <div className="part">
        <div className="label">{delta >= 0 ? '今回 増' : '今回 減'}</div>
        <div className={`qtybig ${delta >= 0 ? 'plus' : 'minus'}`}>
          {delta >= 0 ? '+' : '−'}
          {Math.abs(delta)}
        </div>
      </div>
      <div className="arrow">→</div>
      <div className="part">
        <div className="label">確定後</div>
        <div className={`qtybig ${after < 0 ? 'minus' : ''}`}>
          {after}
          <small>{unit}</small>
        </div>
      </div>
    </div>
  );
}

/** 確定コマンドの状態表示（送信中・結果確認中・保存失敗・確定済み） */
export function CmdStatus({ state, onCheck, onResend, doneText }: { state: CmdState; onCheck: () => void; onResend: () => void; doneText?: ReactNode }) {
  if (state.phase === 'sending') return <p className="msg msg-info" role="status">送信中…（画面を閉じないでください）</p>;
  if (state.phase === 'checking') return <p className="msg msg-info" role="status">結果確認中…</p>;
  if (state.phase === 'unknown')
    return (
      <div className="msg msg-warn" role="alert">
        <strong>結果確認中：</strong>
        {state.message}
        <div className="btn-row">
          <button className="btn btn-primary" onClick={onCheck}>
            処理状況を確認
          </button>
        </div>
        <div className="small">確認するまで、新しい操作としてやり直さないでください（二重登録を防ぐため）。</div>
      </div>
    );
  if (state.phase === 'error') return <ErrorMsg error={state.error} />;
  if (state.phase === 'done')
    return (
      <div className="msg msg-ok" role="status">
        <strong>確定済み</strong>
        {state.replayed && '（既に処理済みの操作でした。二重には反映していません）'}
        {doneText && <div>{doneText}</div>}
      </div>
    );
  void onResend;
  return null;
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet-body">
        <div className="row" style={{ alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn btn-small" style={{ flex: '0 0 auto' }} onClick={onClose}>
            閉じる
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export interface SkuHit {
  id: string;
  code: string;
  name: string;
  color: string;
  size: string;
  unit: string;
  photoFileId: string | null;
  available: number;
  hold: number;
  onOrder: number;
  locations: { locationId: string; name: string; kind: string; qty: number }[];
}

/**
 * SKU選択：検索欄（キーボード型スキャナーは入力＋Enterで読取）＋カメラ読取。
 * 読み取った後は一旦止め、写真・SKU・バリエーションを表示して確認させる。
 */
export function SkuPicker({ onPick, locationId, placeholder }: { onPick: (s: SkuHit) => void; locationId?: string; placeholder?: string }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SkuHit[] | null>(null);
  const [scan, setScan] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async (text: string) => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await get<{ rows: SkuHit[] }>(`/api/inventory${qs({ q: text, locationId, limit: 30 })}`);
      setHits(r.rows);
      if (!r.rows.length) setMsg('該当する商品がありません');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const resolve = async (code: string) => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await get<any>(`/api/resolve${qs({ code })}`);
      if (r.type === 'sku') {
        const s = await get<any>(`/api/skus/${r.skuId}`);
        onPick({
          id: s.id,
          code: s.code,
          name: s.name,
          color: s.color,
          size: s.size,
          unit: s.unit,
          photoFileId: s.photoFileId,
          available: s.available,
          hold: s.hold,
          onOrder: s.onOrder,
          locations: s.balances.map((b: any) => ({ locationId: b.locationId, name: b.name, kind: b.kind, qty: b.qty })),
        });
        setQ('');
        setHits(null);
      } else if (r.type === 'location') {
        setMsg(`場所「${r.name}」のコードです。商品のコードを読み取ってください。`);
      } else {
        setMsg(`${r.message ?? '登録されていないコードです'}（${code}）`);
        await search(code);
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <form
        className="searchbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) resolve(q.trim());
        }}
      >
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder ?? 'SKU・JAN・商品名で検索（スキャナー可）'}
          aria-label="商品を検索"
          enterKeyHint="search"
          autoComplete="off"
        />
        <button type="button" className="btn" onClick={() => q.trim() && search(q.trim())} disabled={busy}>
          検索
        </button>
        <button type="button" className="btn btn-primary" onClick={() => setScan(true)} aria-label="カメラで読み取る">
          📷 読取
        </button>
      </form>
      {msg && <p className="msg msg-warn">{msg}</p>}
      {busy && <Loading text="検索中…" />}
      {hits && hits.length > 0 && (
        <div className="cards" style={{ marginTop: '0.5rem' }}>
          {hits.map((h) => (
            <button
              key={h.id}
              type="button"
              className="item"
              style={{ width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit' }}
              onClick={() => {
                onPick(h);
                setHits(null);
                setQ('');
              }}
            >
              <Photo fileId={h.photoFileId} alt={h.name} />
              <div>
                <div>
                  <strong>{h.code}</strong> {h.name}
                </div>
                <div className="small muted">{variant(h.color, h.size)}</div>
                <div className="small">
                  利用可能 {h.available}
                  {h.unit}
                  {h.hold > 0 && ` ／ 保留 ${h.hold}`}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {scan && (
        <Scanner
          hint="商品のJAN・内部QR・SKUコードを読み取ります"
          onClose={() => setScan(false)}
          onDetected={(text) => {
            setScan(false);
            resolve(text);
          }}
        />
      )}
    </div>
  );
}

export function SkuCard({ s, onClear }: { s: SkuHit; onClear?: () => void }) {
  return (
    <div className="card" style={{ display: 'flex', gap: '0.8rem', alignItems: 'flex-start' }}>
      <Photo fileId={s.photoFileId} alt={s.name} large />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: '1.1rem' }}>
          <strong>{s.code}</strong>
        </div>
        <div>{s.name}</div>
        {variant(s.color, s.size) && <div className="badge">{variant(s.color, s.size)}</div>}
        <div className="small" style={{ marginTop: '0.3rem' }}>
          利用可能 <strong>{s.available}</strong>
          {s.unit}
          {s.hold > 0 && <> ／ 保留 {s.hold}</>}
          {s.onOrder > 0 && <> ／ 発注残 {s.onOrder}</>}
        </div>
        <div className="small muted">{s.locations.filter((l) => l.qty > 0).map((l) => `${l.name}${l.kind === 'hold' ? '(保留)' : ''} ${l.qty}`).join('、') || '在庫なし'}</div>
        {onClear && (
          <button className="btn btn-small" style={{ marginTop: '0.4rem' }} onClick={onClear}>
            別の商品を選ぶ
          </button>
        )}
      </div>
    </div>
  );
}

export interface Loc {
  id: string;
  code: string;
  name: string;
  kind: 'normal' | 'hold';
  stocktakeId: string | null;
  stNo?: string | null;
  archived?: boolean;
}

export function LocationSelect({
  locations,
  value,
  onChange,
  label,
  filter,
  qtyOf,
  unit,
}: {
  locations: Loc[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  filter?: (l: Loc) => boolean;
  qtyOf?: (id: string) => number | undefined;
  unit?: string;
}) {
  const [scan, setScan] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const list = locations.filter((l) => !l.archived && (!filter || filter(l)));
  return (
    <div className="field">
      <label htmlFor={`loc-${label}`} style={{ display: 'block', fontWeight: 600, fontSize: '0.9rem' }}>
        {label}
      </label>
      <div className="searchbar">
        <select id={`loc-${label}`} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">選択してください</option>
          {list.map((l) => (
            <option key={l.id} value={l.id} disabled={!!l.stocktakeId}>
              {l.name}（{l.code}）{l.kind === 'hold' ? '［保留］' : ''}
              {qtyOf && qtyOf(l.id) !== undefined ? ` 在庫${qtyOf(l.id)}${unit ?? ''}` : ''}
              {l.stocktakeId ? ' 棚卸中' : ''}
            </option>
          ))}
        </select>
        <button type="button" className="btn" aria-label={`${label}をQRで選ぶ`} onClick={() => setScan(true)}>
          📷
        </button>
      </div>
      {msg && <p className="msg msg-warn">{msg}</p>}
      {scan && (
        <Scanner
          hint="場所のQRラベルを読み取ります"
          onClose={() => setScan(false)}
          onDetected={async (text) => {
            setScan(false);
            try {
              const r = await get<any>(`/api/resolve${qs({ code: text })}`);
              if (r.type === 'location' && list.some((l) => l.id === r.locationId)) {
                onChange(r.locationId);
                setMsg(null);
              } else if (r.type === 'location') setMsg(`「${r.name}」はこの操作では選べません`);
              else setMsg('場所のQRではありません');
            } catch (e) {
              setMsg((e as Error).message);
            }
          }}
        />
      )}
    </div>
  );
}

export function useLocations() {
  return useFetch<Loc[]>('/api/locations');
}

export function StatusLink({ to, n, label, tone }: { to: string; n: number | undefined; label: string; tone?: 'warn' | 'err' }) {
  return (
    <Link to={to} className="stat">
      <div className={`n ${tone === 'err' && n ? 'minus' : ''}`}>{n ?? '–'}</div>
      <div className="l">{label}</div>
    </Link>
  );
}

export function BusinessDate({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="業務日付" hint="過去日を入力しても、履歴の並びは確定した順番のままです">
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)} required />
    </Field>
  );
}

export function todayTokyo() {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

export function fmtDateTime(iso: string) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
}
