import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { api, del, get, post, put, qs, ApiError } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Empty, ErrorMsg, Field, KindBadge, Loading, Photo, Sheet, useFetch, variant, fmtDateTime } from '../components/ui';
import { Scanner } from '../components/Scanner';

const FILTERS: [string, string][] = [
  ['', 'すべて'],
  ['zero', '在庫0'],
  ['below_safety', '安全在庫割れ'],
  ['replenish', '補充候補'],
  ['on_order', '入荷待ち'],
  ['overdue', '納期超過'],
  ['hold', '保留あり'],
  ['stocktake', '棚卸停止中'],
  ['archived', 'アーカイブ'],
];

export function InventoryList() {
  const [sp, setSp] = useSearchParams();
  const filter = sp.get('filter') ?? '';
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [offset, setOffset] = useState(0);
  const [scan, setScan] = useState(false);
  const nav = useNavigate();
  const { me } = useApp();
  const { data, error, loading } = useFetch<{ rows: any[]; hasMore: boolean }>(`/api/inventory${qs({ q: sp.get('q'), filter, limit: 50, offset })}`, [me?.dataEpoch]);
  useEffect(() => setOffset(0), [filter, sp]);
  return (
    <div>
      <div className="row" style={{ alignItems: 'center' }}>
        <h1 style={{ flex: 1 }}>在庫</h1>
        <Link to="/skus/new" className="btn btn-small" style={{ flex: '0 0 auto' }}>
          ＋ 商品登録
        </Link>
      </div>
      <form
        className="searchbar"
        onSubmit={(e) => {
          e.preventDefault();
          setSp(qs({ q, filter }).slice(1));
        }}
      >
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="SKU・コード・商品名・カテゴリ・仕入先・場所" aria-label="在庫を検索" enterKeyHint="search" />
        <button className="btn">検索</button>
        <button type="button" className="btn btn-primary" onClick={() => setScan(true)} aria-label="カメラで読み取る">
          📷
        </button>
      </form>
      <div className="chips" role="group" aria-label="絞り込み">
        {FILTERS.map(([v, l]) => (
          <button key={v} className={`chip ${filter === v ? 'on' : ''}`} aria-pressed={filter === v} onClick={() => setSp(qs({ q: sp.get('q'), filter: v }).slice(1))}>
            {l}
          </button>
        ))}
      </div>
      {loading && <Loading />}
      <ErrorMsg error={error} />
      {data && data.rows.length === 0 && <Empty>該当する商品はありません。{!sp.get('q') && !filter && <Link to="/welcome">はじめに</Link>}</Empty>}
      {data && data.rows.length > 0 && (
        <>
          <div className="cards only-mobile">
            {data.rows.map((r) => (
              <Link key={r.id} to={`/skus/${r.id}`} className="item">
                <Photo fileId={r.photoFileId} alt={r.name} />
                <div style={{ flex: 1 }}>
                  <div>
                    <strong>{r.code}</strong> {r.name}
                  </div>
                  <div className="small muted">{variant(r.color, r.size)}</div>
                  <div className="small">
                    通常 <strong>{r.available}</strong>
                    {r.unit}
                    {r.hold > 0 && <span className="badge badge-hold"> 保留 {r.hold}</span>}
                    {r.onOrder > 0 && <span> ／ 発注残 {r.onOrder}</span>}
                  </div>
                  <div className="pill-list small">
                    {r.belowSafety && <span className="badge badge-err">安全在庫割れ</span>}
                    {r.recommended > 0 && <span className="badge badge-warn">補充 {r.recommended}</span>}
                    {r.overdue > 0 && <span className="badge badge-err">納期超過 {r.overdue}</span>}
                    {r.inStocktake && <span className="badge">棚卸中</span>}
                  </div>
                </div>
              </Link>
            ))}
          </div>
          <div className="table-wrap hide-mobile">
            <table className="list">
              <thead>
                <tr>
                  <th>写真</th>
                  <th>SKU</th>
                  <th>名称</th>
                  <th>色・サイズ</th>
                  <th className="num">通常在庫</th>
                  <th className="num">保留</th>
                  <th className="num">発注残</th>
                  <th>場所別</th>
                  <th>最終入庫</th>
                  <th>最終出庫</th>
                  <th>状態</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} onClick={() => nav(`/skus/${r.id}`)} style={{ cursor: 'pointer' }}>
                    <td>
                      <Photo fileId={r.photoFileId} alt={r.name} />
                    </td>
                    <td>
                      <Link to={`/skus/${r.id}`}>{r.code}</Link>
                    </td>
                    <td>{r.name}</td>
                    <td>{variant(r.color, r.size)}</td>
                    <td className="num">
                      {r.available} {r.unit}
                    </td>
                    <td className="num">{r.hold || ''}</td>
                    <td className="num">{r.onOrder || ''}</td>
                    <td className="small">{r.locations.map((l: any) => `${l.name}${l.kind === 'hold' ? '(保留)' : ''} ${l.qty}`).join('、')}</td>
                    <td className="small">{r.lastIn ?? ''}</td>
                    <td className="small">{r.lastOut ?? ''}</td>
                    <td className="small">
                      {r.belowSafety && <div className="minus">安全在庫割れ</div>}
                      {r.recommended > 0 && <div>補充 {r.recommended}</div>}
                      {r.overdue > 0 && <div className="minus">納期超過</div>}
                      {!r.configured && <div className="muted">補充設定なし</div>}
                      {r.inStocktake && <div>棚卸中</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="btn-row">
            <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
              前へ
            </button>
            <button className="btn" disabled={!data.hasMore} onClick={() => setOffset(offset + 50)}>
              次へ
            </button>
          </div>
        </>
      )}
      {scan && (
        <Scanner
          onClose={() => setScan(false)}
          onDetected={async (text) => {
            setScan(false);
            const r = await get<any>(`/api/resolve${qs({ code: text })}`).catch(() => null);
            if (r?.type === 'sku') nav(`/skus/${r.skuId}`);
            else if (r?.type === 'location') nav(`/locations/${r.locationId}`);
            else setSp(qs({ q: text }).slice(1));
          }}
        />
      )}
    </div>
  );
}

export function SkuDetail() {
  const { id } = useParams();
  const { data: s, error, loading, reload } = useFetch<any>(`/api/skus/${id}`);
  const hist = useFetch<any>(`/api/history${qs({ skuId: id, limit: 20 })}`);
  const [qr, setQr] = useState<string | null>(null);
  const [codeForm, setCodeForm] = useState<{ code: string; kind: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const nav = useNavigate();
  useEffect(() => {
    if (s) QRCode.toDataURL(`SP:1:SKU:${s.id}`, { margin: 4, width: 220 }).then(setQr);
  }, [s]);
  if (loading && !s) return <Loading />;
  if (error) return <ErrorMsg error={error} />;
  if (!s) return null;
  const r = s.replenishment;
  return (
    <div>
      <div className="row" style={{ alignItems: 'center' }}>
        <h1 style={{ flex: 1 }}>
          {s.code} {s.archived && <span className="badge">アーカイブ</span>}
        </h1>
        <Link to={`/skus/${s.id}/edit`} className="btn btn-small" style={{ flex: '0 0 auto' }}>
          編集
        </Link>
      </div>
      <div className="card" style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap' }}>
        <div>
          <Photo fileId={s.photoFileId} alt={s.name} large />
          <label className="btn btn-small" style={{ marginTop: '0.3rem' }}>
            {photoBusy ? '送信中…' : '写真を選ぶ'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="visually-hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setPhotoBusy(true);
                setErr(null);
                const fd = new FormData();
                fd.append('file', f);
                try {
                  await api('PUT', `/api/skus/${s.id}/photo`, fd);
                  reload();
                } catch (e2) {
                  setErr(e2);
                } finally {
                  setPhotoBusy(false);
                  e.target.value = '';
                }
              }}
            />
          </label>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: '1.15rem' }}>{s.name}</div>
          <div className="muted">
            {[s.groupName, variant(s.color, s.size), s.attrs, s.category, s.brand].filter(Boolean).join(' ／ ')}
          </div>
          <div className="stats" style={{ marginTop: '0.5rem' }}>
            <div className="stat">
              <div className="n">{s.available}</div>
              <div className="l">利用可能（通常場所）{s.unit}</div>
            </div>
            <div className="stat">
              <div className="n">{s.hold}</div>
              <div className="l">保留</div>
            </div>
            <div className="stat">
              <div className="n">{s.onOrder}</div>
              <div className="l">発注残（未入荷）</div>
            </div>
            <div className="stat">
              <div className="n">{r.configured ? r.p : '—'}</div>
              <div className="l">補充判断数量（利用可能＋通常場所への発注残）</div>
            </div>
          </div>
          <p className="small">
            {r.configured ? (
              <>
                {r.belowSafety && <span className="badge badge-err">安全在庫割れ</span>} {r.reason}
                {r.recommended > 0 && (
                  <>
                    ：推奨 <strong>{r.recommended}</strong>
                    {s.unit}
                  </>
                )}
              </>
            ) : (
              <span className="muted">補充設定なし（推奨数は出しません）</span>
            )}
          </p>
        </div>
      </div>
      <ErrorMsg error={err} />
      <div className="btn-row">
        <Link className="btn" to={`/receive?skuId=${s.id}`}>
          入荷待ち
        </Link>
        <Link className="btn" to={`/issue?skuId=${s.id}`}>
          出庫
        </Link>
        <Link className="btn" to={`/transfer?skuId=${s.id}`}>
          移動
        </Link>
        <Link className="btn" to={`/more/outside-receipt?skuId=${s.id}`}>
          発注外入庫
        </Link>
      </div>
      <h2>場所別</h2>
      {s.balances.filter((b: any) => b.qty > 0).length === 0 ? (
        <Empty>在庫はありません</Empty>
      ) : (
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th>場所</th>
                <th>種類</th>
                <th className="num">現物</th>
                <th>最終入庫</th>
                <th>最終出庫</th>
              </tr>
            </thead>
            <tbody>
              {s.balances
                .filter((b: any) => b.qty > 0)
                .map((b: any) => (
                  <tr key={b.locationId}>
                    <td>
                      <Link to={`/locations/${b.locationId}`}>{b.name}</Link> {b.inStocktake && <span className="badge">棚卸中</span>}
                    </td>
                    <td>
                      <KindBadge kind={b.kind} />
                    </td>
                    <td className="num">
                      {b.qty} {s.unit}
                    </td>
                    <td className="small">{b.lastIn ?? ''}</td>
                    <td className="small">{b.lastOut ?? ''}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>関連コード</h2>
      <div className="card">
        {s.codes.length === 0 && <p className="muted small">JAN/EAN 等の関連コードは未登録です</p>}
        {s.codes.map((c: any) => (
          <div key={c.id} className="row" style={{ alignItems: 'center' }}>
            <span>
              <span className="badge">{c.kind === 'JAN13' ? 'JAN/EAN-13' : c.kind === 'EAN8' ? 'EAN-8' : c.kind}</span> {c.code}
            </span>
            <button
              className="btn btn-small"
              style={{ flex: '0 0 auto' }}
              onClick={async () => {
                if (!confirm(`コード ${c.code} の関連付けを外しますか？`)) return;
                await del(`/api/skus/${s.id}/codes/${c.id}`).catch(setErr);
                reload();
              }}
            >
              外す
            </button>
          </div>
        ))}
        <button className="btn btn-small" onClick={() => setCodeForm({ code: '', kind: 'JAN13' })}>
          ＋ コードを追加
        </button>
        <div style={{ marginTop: '0.6rem' }}>
          <div className="small muted">アプリ内部QR（JANとは別物です）</div>
          {qr && <img src={qr} alt={`内部QR ${s.code}`} width={140} height={140} />}
          <div>
            <Link to={`/labels?skuId=${s.id}`} className="btn btn-small">
              QRラベルを印刷
            </Link>
          </div>
        </div>
      </div>
      <h2>補充設定・仕入先</h2>
      <div className="card small">
        <dl className="kv">
          <dt>標準仕入先</dt>
          <dd>{s.supplierName ?? '未設定'}</dd>
          <dt>安全在庫／発注点／目標</dt>
          <dd>{s.replenish ? `${s.replenish.safetyStock} ／ ${s.replenish.reorderPoint} ／ ${s.replenish.targetStock}` : '補充設定なし'}</dd>
          <dt>最小発注数量／発注単位</dt>
          <dd>{s.replenish ? `${s.replenish.minOrderQty} ／ ${s.replenish.orderMultiple}` : '—'}</dd>
          <dt>リードタイム</dt>
          <dd>{s.leadTimeDays ?? '（仕入先の設定）'} 日</dd>
          <dt>単位</dt>
          <dd>{s.unit}</dd>
          <dt>内部メモ</dt>
          <dd>{s.memo || '—'}</dd>
        </dl>
      </div>
      <h2>履歴（新しい順）</h2>
      <HistoryTable rows={hist.data?.rows ?? []} unit={s.unit} />
      <Link to={`/history?skuId=${s.id}`} className="btn btn-small">
        すべての履歴
      </Link>
      <h2>管理</h2>
      <div className="btn-row">
        <button
          className="btn"
          onClick={async () => {
            setErr(null);
            try {
              await post(`/api/skus/${s.id}/archive`, { archived: !s.archived });
              reload();
            } catch (e) {
              setErr(e);
            }
          }}
        >
          {s.archived ? 'アーカイブを解除' : 'アーカイブ'}
        </button>
        <button
          className="btn btn-danger"
          onClick={async () => {
            if (!confirm('履歴のないSKUだけ削除できます。削除しますか？')) return;
            setErr(null);
            try {
              await del(`/api/skus/${s.id}`);
              nav('/inventory');
            } catch (e) {
              setErr(e);
            }
          }}
        >
          削除
        </button>
      </div>
      {codeForm && (
        <Sheet title="関連コードを追加" onClose={() => setCodeForm(null)}>
          <CodeForm skuId={s.id} initial={codeForm} onDone={() => (setCodeForm(null), reload())} />
        </Sheet>
      )}
    </div>
  );
}

function CodeForm({ skuId, initial, onDone }: { skuId: string; initial: { code: string; kind: string }; onDone: () => void }) {
  const [f, setF] = useState(initial);
  const [err, setErr] = useState<unknown>(null);
  const [scan, setScan] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await post(`/api/skus/${skuId}/codes`, f);
          onDone();
        } catch (e2) {
          setErr(e2);
        }
      }}
    >
      <Field label="種類">
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="JAN13">JAN/EAN-13</option>
          <option value="EAN8">EAN-8</option>
          <option value="CODE128">Code128</option>
          <option value="OTHER">その他</option>
        </select>
      </Field>
      <Field label="コード（先頭のゼロも入力）">
        <div className="searchbar">
          <input value={f.code} inputMode={f.kind === 'JAN13' || f.kind === 'EAN8' ? 'numeric' : 'text'} onChange={(e) => setF({ ...f, code: e.target.value })} required />
          <button type="button" className="btn" onClick={() => setScan(true)}>
            📷
          </button>
        </div>
      </Field>
      <p className="small muted">独自の番号をJANとして登録しないでください。独自ラベルにはアプリ内部QRを使います。</p>
      <ErrorMsg error={err} />
      <button className="btn btn-primary btn-block">追加</button>
      {scan && (
        <Scanner
          onClose={() => setScan(false)}
          onDetected={(text, fmt) => {
            setScan(false);
            setF({ code: text, kind: fmt === 'ean_8' ? 'EAN8' : fmt === 'ean_13' ? 'JAN13' : fmt === 'code_128' ? 'CODE128' : 'OTHER' });
          }}
        />
      )}
    </form>
  );
}

export function HistoryTable({ rows, unit, onReverse }: { rows: any[]; unit?: string; onReverse?: (r: any) => void }) {
  if (!rows.length) return <Empty>履歴はありません</Empty>;
  return (
    <div className="table-wrap">
      <table className="list">
        <thead>
          <tr>
            <th>伝票</th>
            <th>日付</th>
            <th>種別</th>
            <th>商品</th>
            <th>場所</th>
            <th className="num">増減</th>
            <th>関連・理由</th>
            {onReverse && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Link to={`/ops/${r.opId}`}>{r.opNo}</Link>
              </td>
              <td className="small">
                {r.businessDate}
                <div className="muted">{fmtDateTime(r.committedAt)}</div>
              </td>
              <td className="small">
                {r.kindLabel}
                {r.purpose && `（${{ sale: '販売', sample: 'サンプル配布', business_use: '業務使用', other: 'その他' }[r.purpose as string]}）`}
                {r.noSource && <div className="badge">元履歴なし</div>}
              </td>
              <td className="small">
                <Link to={`/skus/${r.skuId}`}>{r.sku.code}</Link> {r.sku.name}
              </td>
              <td className="small">
                {r.location.name}
                {r.location.kind === 'hold' && '（保留）'}
              </td>
              <td className={`num ${r.qty > 0 ? 'plus' : 'minus'}`}>
                {r.qty > 0 ? `+${r.qty}` : `−${Math.abs(r.qty)}`} {unit ?? r.sku.unit}
                {r.reversed > 0 && <div className="small muted">取消済 {r.reversed}</div>}
              </td>
              <td className="small">
                {r.poNo && (
                  <div>
                    <Link to={`/pos/${r.poId}`}>{r.poNo}</Link>
                  </div>
                )}
                {r.stNo && (
                  <div>
                    <Link to={`/stocktakes/${r.stocktakeId}`}>{r.stNo}</Link>
                  </div>
                )}
                {r.reason && <div>{r.reason}</div>}
                {r.externalRef && <div className="muted">参照 {r.externalRef}</div>}
              </td>
              {onReverse && (
                <td>
                  {!['reversal', 'stocktake_adjust'].includes(r.kind) && Math.abs(r.qty) > r.reversed && (
                    <button className="btn btn-small" onClick={() => onReverse(r)}>
                      取消
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const emptySku = {
  code: '',
  name: '',
  groupName: '',
  color: '',
  size: '',
  attrs: '',
  category: '',
  brand: '',
  unit: '個',
  supplierId: '',
  memo: '',
  leadTimeDays: '',
  rep: { safetyStock: '', reorderPoint: '', targetStock: '', minOrderQty: '', orderMultiple: '' },
};

export function SkuEdit() {
  const { id } = useParams();
  const isNew = !id;
  const nav = useNavigate();
  const sups = useFetch<any[]>('/api/suppliers');
  const [f, setF] = useState<any>(emptySku);
  const [version, setVersion] = useState(0);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!id) return;
    get<any>(`/api/skus/${id}`).then((s) => {
      setVersion(s.version);
      setF({
        code: s.code,
        name: s.name,
        groupName: s.groupName,
        color: s.color,
        size: s.size,
        attrs: s.attrs,
        category: s.category,
        brand: s.brand,
        unit: s.unit,
        supplierId: s.supplierId ?? '',
        memo: s.memo,
        leadTimeDays: s.leadTimeDays ?? '',
        rep: s.replenish
          ? Object.fromEntries(Object.entries(s.replenish).map(([k, v]) => [k, String(v)]))
          : { safetyStock: '', reorderPoint: '', targetStock: '', minOrderQty: '', orderMultiple: '' },
      });
    }, setErr);
  }, [id]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const setRep = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, rep: { ...f.rep, [k]: e.target.value } });
  const repVals = Object.values(f.rep) as string[];
  const repAny = repVals.some((v) => v !== '');
  return (
    <div>
      <h1>{isNew ? '商品（SKU）を登録' : '商品を編集'}</h1>
      <p className="small muted">色・サイズ違いは別のSKUとして登録します（例：Tシャツ黒M、黒L）。</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          const num = (v: string) => (v === '' ? null : Number(v));
          if (repAny && repVals.some((v) => v === '' || !/^\d+$/.test(v))) {
            setErr(new Error('補充設定はすべて0以上の整数で入力するか、すべて空欄にしてください'));
            return;
          }
          const body = {
            code: f.code,
            name: f.name,
            groupName: f.groupName,
            color: f.color,
            size: f.size,
            attrs: f.attrs,
            category: f.category,
            brand: f.brand,
            unit: f.unit,
            supplierId: f.supplierId || null,
            memo: f.memo,
            leadTimeDays: num(String(f.leadTimeDays)),
            replenish: repAny ? Object.fromEntries(Object.entries(f.rep).map(([k, v]) => [k, Number(v)])) : null,
          };
          setBusy(true);
          try {
            if (isNew) {
              const r = await post<{ id: string }>('/api/skus', body);
              nav(`/skus/${r.id}`);
            } else {
              await put(`/api/skus/${id}`, { ...body, version });
              nav(`/skus/${id}`);
            }
          } catch (e2) {
            setErr(e2);
            if (e2 instanceof ApiError && e2.code === 'VERSION_CONFLICT') setErr(new Error(`${e2.message}（ページを開き直すと最新の内容が表示されます）`));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="card">
          <div className="row">
            <Field label="SKUコード（必須・一意）" hint="大文字小文字の違いだけのコードは同じとみなします">
              <input value={f.code} onChange={set('code')} maxLength={60} required autoCapitalize="characters" />
            </Field>
            <Field label="名称（必須）">
              <input value={f.name} onChange={set('name')} maxLength={200} required />
            </Field>
          </div>
          <div className="row">
            <Field label="商品グループ（表示用）">
              <input value={f.groupName} onChange={set('groupName')} maxLength={200} />
            </Field>
            <Field label="色">
              <input value={f.color} onChange={set('color')} maxLength={60} />
            </Field>
            <Field label="サイズ">
              <input value={f.size} onChange={set('size')} maxLength={60} />
            </Field>
          </div>
          <div className="row">
            <Field label="その他属性">
              <input value={f.attrs} onChange={set('attrs')} maxLength={200} />
            </Field>
            <Field label="カテゴリ">
              <input value={f.category} onChange={set('category')} maxLength={100} />
            </Field>
            <Field label="ブランド">
              <input value={f.brand} onChange={set('brand')} maxLength={100} />
            </Field>
          </div>
          <div className="row">
            <Field label="基本単位（整数で数える）">
              <input value={f.unit} onChange={set('unit')} maxLength={10} required list="units" />
              <datalist id="units">
                <option value="個" />
                <option value="枚" />
                <option value="本" />
                <option value="冊" />
                <option value="セット" />
              </datalist>
            </Field>
            <Field label="標準仕入先">
              <select value={f.supplierId} onChange={set('supplierId')}>
                <option value="">未設定</option>
                {(sups.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="標準リードタイム（日）">
              <input inputMode="numeric" value={f.leadTimeDays} onChange={set('leadTimeDays')} />
            </Field>
          </div>
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>補充設定（任意）</h2>
          <p className="small muted">0 ≦ 安全在庫 ≦ 発注点 ＜ 目標在庫。未入力のSKUは「補充設定なし」と表示し、推奨数を出しません。</p>
          <div className="row">
            {(
              [
                ['safetyStock', '安全在庫'],
                ['reorderPoint', '発注点'],
                ['targetStock', '目標在庫'],
                ['minOrderQty', '最小発注数量'],
                ['orderMultiple', '発注単位'],
              ] as const
            ).map(([k, l]) => (
              <Field key={k} label={l}>
                <input inputMode="numeric" value={f.rep[k]} onChange={setRep(k)} />
              </Field>
            ))}
          </div>
        </div>
        <Field label="内部メモ（帳票には出ません）">
          <textarea value={f.memo} onChange={set('memo')} maxLength={2000} />
        </Field>
        <ErrorMsg error={err} />
        <div className="sticky-actions">
          <button className="btn btn-primary btn-block" disabled={busy}>
            {isNew ? '登録する' : '保存する'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function IdleList() {
  const { data, error, loading } = useFetch<any[]>('/api/idle?days=90');
  return (
    <div>
      <h1>直近90日 出庫なし</h1>
      <p className="small muted">通常場所に在庫があり、最終出庫日から90日以上経過（または出庫記録なし）のSKU。ロット管理をしていないため、現物の在庫年齢は断定しません。</p>
      {loading && <Loading />}
      <ErrorMsg error={error} />
      {data && data.length === 0 && <Empty>該当なし</Empty>}
      {data && data.length > 0 && (
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th>SKU</th>
                <th>名称</th>
                <th className="num">通常在庫</th>
                <th>最終出庫</th>
                <th className="num">経過日数</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.skuId}>
                  <td>
                    <Link to={`/skus/${r.skuId}`}>{r.code}</Link>
                  </td>
                  <td>{r.name}</td>
                  <td className="num">
                    {r.qty} {r.unit}
                  </td>
                  <td>{r.lastOut ?? '出庫記録なし'}</td>
                  <td className="num">{r.daysSinceOut ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
