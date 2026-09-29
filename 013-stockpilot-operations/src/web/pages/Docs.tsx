import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchBlob, post } from '../lib/api';
import { ErrorMsg, Field, Loading, useFetch, useLocations } from '../components/ui';

/**
 * 帳票の作成 → 表示／保存／共有。
 * iPhone では印刷だけに頼らず、PDFの表示・ダウンロード・共有シートを用意する。
 * 共有はファイル準備後の明示的なタップで呼び出し、キャンセルはエラー扱いしない（相手の受領も保証しない）。
 */
export function DocumentActions({ create, label, note }: { create: () => Promise<{ documentId: string }>; label: string; note?: string }) {
  const [doc, setDoc] = useState<{ id: string; blob: Blob; url: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (doc) URL.revokeObjectURL(doc.url);
    },
    [doc],
  );
  const prepare = async () => {
    setBusy(true);
    setErr(null);
    setShareMsg(null);
    try {
      const { documentId } = await create();
      const blob = await fetchBlob(`/api/documents/${documentId}/pdf`);
      setDoc({ id: documentId, blob, url: URL.createObjectURL(blob), name: `${label}.pdf` });
    } catch (e) {
      setErr(new Error(`PDFを作成できませんでした。在庫や発注の内容は変わっていません。もう一度お試しください。（${(e as Error).message}）`));
    } finally {
      setBusy(false);
    }
  };
  const file = doc ? new File([doc.blob], doc.name, { type: 'application/pdf' }) : null;
  const canShare = !!file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{label}</h2>
      {note && <p className="small muted">{note}</p>}
      <ErrorMsg error={err} />
      {!doc ? (
        <button className="btn" onClick={prepare} disabled={busy}>
          {busy ? '作成中…' : 'PDFを作成'}
        </button>
      ) : (
        <div className="btn-row">
          <a className="btn" href={doc.url} target="_blank" rel="noopener">
            PDFを表示
          </a>
          <a className="btn" href={`/api/documents/${doc.id}/pdf?download=1`} download={doc.name}>
            ファイルに保存
          </a>
          {canShare && (
            <button
              className="btn btn-primary"
              onClick={async () => {
                try {
                  await navigator.share({ files: [file!], title: doc.name });
                  setShareMsg('共有シートでの操作が完了しました（相手が受け取ったかどうかは確認できません）。');
                } catch (e) {
                  if ((e as Error).name === 'AbortError') setShareMsg('共有をキャンセルしました。');
                  else setShareMsg('共有できませんでした。「PDFを表示」または「ファイルに保存」を使ってください。');
                }
              }}
            >
              共有…
            </button>
          )}
          <button className="btn" onClick={prepare} disabled={busy}>
            作り直す
          </button>
        </div>
      )}
      {doc && !canShare && <p className="small muted">この端末では共有シートを使えません。表示または保存してから送付してください。</p>}
      {shareMsg && <p className="small">{shareMsg}</p>}
    </div>
  );
}

export function Labels() {
  const [sp] = useSearchParams();
  const locs = useLocations();
  const [q, setQ] = useState('');
  const skus = useFetch<{ rows: any[] }>(`/api/inventory?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`, [q]);
  const [skuSel, setSkuSel] = useState<Record<string, boolean>>(sp.get('skuId') ? { [sp.get('skuId')!]: true } : {});
  const [locSel, setLocSel] = useState<Record<string, boolean>>({});
  const [copies, setCopies] = useState(1);
  const skuIds = Object.keys(skuSel).filter((k) => skuSel[k]);
  const locationIds = Object.keys(locSel).filter((k) => locSel[k]);
  return (
    <div>
      <h1>QRラベル（A4・24面）</h1>
      <p className="small muted">
        アプリ内部QRのラベルを作ります（JANとは別の、このアカウント内だけで使えるコードです）。QRの周囲には読み取りに必要な余白を確保しています。商品名・SKUや場所名も印字するので、読めない場合も識別できます。
      </p>
      <h2>商品</h2>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="絞り込み" aria-label="商品を絞り込み" />
      {skus.loading && <Loading />}
      <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8, background: '#fff', marginTop: 6 }}>
        {(skus.data?.rows ?? []).map((s) => (
          <label key={s.id} className="check" style={{ padding: '0 0.6rem' }}>
            <input type="checkbox" checked={!!skuSel[s.id]} onChange={(e) => setSkuSel({ ...skuSel, [s.id]: e.target.checked })} />
            <span>
              {s.code} {s.name} {[s.color, s.size].filter(Boolean).join(' / ')}
            </span>
          </label>
        ))}
      </div>
      <h2>保管場所</h2>
      {(locs.data ?? []).map((l) => (
        <label key={l.id} className="check">
          <input type="checkbox" checked={!!locSel[l.id]} onChange={(e) => setLocSel({ ...locSel, [l.id]: e.target.checked })} />
          <span>
            {l.name}（{l.code}）{l.kind === 'hold' && '［保留］'}
          </span>
        </label>
      ))}
      <Field label="1件あたりの枚数">
        <input type="number" min={1} max={24} value={copies} onChange={(e) => setCopies(Math.max(1, Math.min(24, Number(e.target.value) || 1)))} />
      </Field>
      <p className="small">
        選択：商品 {skuIds.length}件・場所 {locationIds.length}件 → {(skuIds.length + locationIds.length) * copies}枚
      </p>
      {skuIds.length + locationIds.length > 0 && (
        <DocumentActions key={`${skuIds.join()}|${locationIds.join()}|${copies}`} create={() => post('/api/labels', { skuIds, locationIds, copies })} label="QRラベル" note="印刷時は「実際のサイズ（100%）」を選んでください。" />
      )}
    </div>
  );
}
