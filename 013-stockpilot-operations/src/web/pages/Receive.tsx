import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { get, qs } from '../lib/api';
import { useApp } from '../lib/app-context';
import { useCommand } from '../lib/useCommand';
import {
  BusinessDate,
  ChangePreview,
  CmdStatus,
  Empty,
  ErrorMsg,
  Field,
  LocationSelect,
  Loading,
  Photo,
  QtyInput,
  SkuCard,
  SkuPicker,
  todayTokyo,
  useFetch,
  useLocations,
  variant,
  type SkuHit,
} from '../components/ui';
import { Scanner } from '../components/Scanner';
import { ResultLines } from './Ops';

/** 入荷待ち一覧（仕入先・納期・SKU・部分入荷・納期超過で絞込） */
export function PendingList() {
  const [sp, setSp] = useSearchParams();
  const { me } = useApp();
  const sups = useFetch<any[]>('/api/suppliers');
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [scan, setScan] = useState(false);
  const url = `/api/pos/pending-lines${qs({ supplierId: sp.get('supplierId'), skuId: sp.get('skuId'), overdue: sp.get('overdue') ? 1 : undefined, partial: sp.get('partial') ? 1 : undefined, q: sp.get('q'), limit: 100 })}`;
  const { data, error, loading } = useFetch<any[]>(url, [me?.dataEpoch]);
  const setParam = (k: string, v?: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n);
  };
  const byPo = new Map<string, any[]>();
  for (const l of data ?? []) byPo.set(l.poId, [...(byPo.get(l.poId) ?? []), l]);
  return (
    <div>
      <h1>入庫（入荷待ち）</h1>
      <p className="small muted">発注を開き、今回届いた数量と入庫先を確認して確定します。発注にない入庫は <Link to="/more/outside-receipt">発注外入庫</Link>。</p>
      <form
        className="searchbar"
        onSubmit={(e) => {
          e.preventDefault();
          setParam('q', q);
        }}
      >
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="発注番号・SKU・商品名・仕入先" aria-label="入荷待ちを検索" />
        <button className="btn">検索</button>
        <button type="button" className="btn btn-primary" onClick={() => setScan(true)}>
          📷
        </button>
      </form>
      <div className="row">
        <Field label="仕入先">
          <select value={sp.get('supplierId') ?? ''} onChange={(e) => setParam('supplierId', e.target.value)}>
            <option value="">すべて</option>
            {(sups.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="chips">
        <button className={`chip ${sp.get('overdue') ? 'on' : ''}`} onClick={() => setParam('overdue', sp.get('overdue') ? '' : '1')}>
          納期超過
        </button>
        <button className={`chip ${sp.get('partial') ? 'on' : ''}`} onClick={() => setParam('partial', sp.get('partial') ? '' : '1')}>
          一部入荷あり
        </button>
        {sp.get('skuId') && (
          <button className="chip on" onClick={() => setParam('skuId', '')}>
            SKU指定を解除
          </button>
        )}
      </div>
      {loading && <Loading />}
      <ErrorMsg error={error} />
      {data && data.length === 0 && <Empty>入荷待ちの明細はありません</Empty>}
      {[...byPo.entries()].map(([poId, ls]) => (
        <div className="card" key={poId}>
          <div className="row" style={{ alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <strong>{ls[0].poNo}</strong> {ls[0].supplierName}
              <div className="small muted">発注日 {ls[0].orderedDate}</div>
            </div>
            <Link to={`/receive/${poId}`} className="btn btn-primary" style={{ flex: '0 0 auto' }}>
              入荷を登録
            </Link>
          </div>
          {ls.map((l) => (
            <div key={l.id} className="small" style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
              <Photo fileId={l.photoFileId} alt={l.skuName} />
              <div>
                <strong>{l.skuCode}</strong> {l.skuName} {variant(l.color, l.size)}
                <div>
                  発注 {l.qty} ／ 受領済 {l.received} ／ <strong>残 {l.outstanding}</strong> {l.unit}
                  {l.cancelled > 0 && ` ／ 打切り ${l.cancelled}`}
                </div>
                <div>
                  納期 {l.dueDate ?? '未設定'} {l.overdue && <span className="badge badge-err">納期超過</span>} ／ 納入 {l.locationName}
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
      {scan && (
        <Scanner
          onClose={() => setScan(false)}
          onDetected={async (text) => {
            setScan(false);
            const r = await get<any>(`/api/resolve${qs({ code: text })}`).catch(() => null);
            if (r?.type === 'sku') setParam('skuId', r.skuId);
            else setParam('q', text);
          }}
        />
      )}
    </div>
  );
}

interface Split {
  locationId: string;
  qty: number | null;
}

/** 入荷登録（分納・複数場所・検品保留への振り分け） */
export function ReceivePo() {
  const { id } = useParams();
  const { online } = useApp();
  const locs = useLocations();
  const po = useFetch<any>(`/api/pos/${id}`);
  const cmd = useCommand(`/api/pos/${id}/receive`);
  const [sel, setSel] = useState<Record<string, Split[]>>({});
  const [closeShort, setCloseShort] = useState<Record<string, boolean>>({});
  const [closeReason, setCloseReason] = useState('');
  const [date, setDate] = useState(todayTokyo());
  const [note, setNote] = useState('');
  const [step, setStep] = useState<'input' | 'confirm'>('input');
  const [balances, setBalances] = useState<Record<string, Record<string, number>>>({});
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [scan, setScan] = useState(false);
  const p = po.data;
  useEffect(() => {
    if (!p) return;
    // 現在庫（入庫前）を読み、確定後の数量を大きく表示する
    Promise.all(p.lines.map((l: any) => get<any>(`/api/skus/${l.skuId}`))).then((ss) => {
      const m: Record<string, Record<string, number>> = {};
      for (const s of ss) m[s.id] = Object.fromEntries(s.balances.map((b: any) => [b.locationId, b.qty]));
      setBalances(m);
    });
  }, [p]);
  if (po.loading && !p) return <Loading />;
  if (po.error) return <ErrorMsg error={po.error} />;
  if (!p) return null;
  const open = p.lines.filter((l: any) => l.outstanding > 0);
  const chosen = Object.entries(sel).filter(([, s]) => s.length > 0);
  const total = (lid: string) => (sel[lid] ?? []).reduce((a, s) => a + (s.qty ?? 0), 0);
  const invalid = chosen.some(([lid, s]) => {
    const line = p.lines.find((l: any) => l.id === lid);
    return s.some((x) => !x.locationId || !x.qty) || total(lid) > line.outstanding || new Set(s.map((x) => x.locationId)).size !== s.length;
  });
  const shortIds = Object.entries(closeShort).filter(([, v]) => v).map(([k]) => k);
  const canConfirm = chosen.length > 0 && !invalid && (!shortIds.length || closeReason.trim());
  const cur = (skuId: string, locId: string) => balances[skuId]?.[locId] ?? 0;

  if (cmd.state.phase === 'done') {
    return (
      <div>
        <h1>入荷 {p.poNo}</h1>
        <CmdStatus state={cmd.state} onCheck={cmd.check} onResend={cmd.resend} />
        <ResultLines result={cmd.state.result} />
        <div className="btn-row">
          <Link to={`/pos/${p.id}`} className="btn">
            発注の状態を見る
          </Link>
          <Link to="/receive" className="btn btn-primary">
            入荷待ち一覧へ
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div>
      <h1>入荷 {p.poNo}</h1>
      <p className="small">
        {p.supplierName} ／ 状態 <strong>{p.displayStatusLabel}</strong>
      </p>
      <div className="steps">
        <span className={step === 'input' ? 'on' : ''}>1 届いた明細・数量・入庫先</span>
        <span className={step === 'confirm' ? 'on' : ''}>2 確認して確定</span>
      </div>
      {p.status !== 'placed' && <p className="msg msg-warn">下書きの発注には入荷できません。先に「発注済みにする」を行ってください。</p>}
      {step === 'input' && (
        <>
          <button className="btn btn-block" onClick={() => setScan(true)}>
            📷 商品コードを読んで明細を選ぶ
          </button>
          {scanMsg && <p className="msg msg-warn">{scanMsg}</p>}
          {open.length === 0 && <Empty>未入荷の明細はありません</Empty>}
          {open.map((l: any) => {
            const on = !!sel[l.id];
            return (
              <div className="card" key={l.id} style={on ? { borderColor: 'var(--brand)', borderWidth: 2 } : undefined}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => {
                      const n = { ...sel };
                      if (e.target.checked) n[l.id] = [{ locationId: l.locationId, qty: null }];
                      else delete n[l.id];
                      setSel(n);
                    }}
                  />
                  <span>
                    今回届いた（{l.skuCode} {l.skuName} {variant(l.color, l.size)}）
                  </span>
                </label>
                <div className="small">
                  発注 {l.qty} ／ 受領済 {l.received} ／ <strong>未入荷 {l.outstanding}</strong> {l.unit} ／ 納入予定 {l.locationName}
                </div>
                {on &&
                  sel[l.id].map((s, i) => (
                    <div key={i} style={{ borderTop: '1px dashed var(--line)', marginTop: '0.5rem', paddingTop: '0.5rem' }}>
                      <LocationSelect
                        locations={locs.data ?? []}
                        value={s.locationId}
                        onChange={(v) => setSel({ ...sel, [l.id]: sel[l.id].map((x, j) => (j === i ? { ...x, locationId: v } : x)) })}
                        label={i === 0 ? '入庫先' : `入庫先 ${i + 1}（例：検品保留へ）`}
                      />
                      <QtyInput label="今回の数量" unit={l.unit} value={s.qty} max={l.outstanding} onChange={(v) => setSel({ ...sel, [l.id]: sel[l.id].map((x, j) => (j === i ? { ...x, qty: v } : x)) })} />
                      {i > 0 && (
                        <button className="btn btn-small" onClick={() => setSel({ ...sel, [l.id]: sel[l.id].filter((_, j) => j !== i) })}>
                          この振り分けを削除
                        </button>
                      )}
                    </div>
                  ))}
                {on && (
                  <>
                    <button className="btn btn-small" onClick={() => setSel({ ...sel, [l.id]: [...sel[l.id], { locationId: (locs.data ?? []).find((x) => x.kind === 'hold')?.id ?? '', qty: null }] })}>
                      ＋ 別の場所にも振り分ける（不良を保留へ等）
                    </button>
                    <p className="small">
                      今回合計 <strong>{total(l.id)}</strong> ／ 入荷後の未入荷 <strong>{Math.max(0, l.outstanding - total(l.id))}</strong>
                      {total(l.id) > l.outstanding && <span className="minus"> 発注残より多い数量は入荷できません（発注の訂正、または発注外入庫を使ってください）</span>}
                    </p>
                    {total(l.id) > 0 && total(l.id) < l.outstanding && (
                      <label className="check">
                        <input type="checkbox" checked={!!closeShort[l.id]} onChange={(e) => setCloseShort({ ...closeShort, [l.id]: e.target.checked })} />
                        <span className="small">残り{l.outstanding - total(l.id)}は届かない（仕入先に確認済み・残数を打ち切る）。チェックしなければ未入荷として残ります。</span>
                      </label>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {shortIds.length > 0 && (
            <Field label="打切りの理由（必須）">
              <input value={closeReason} onChange={(e) => setCloseReason(e.target.value)} maxLength={500} />
            </Field>
          )}
          <BusinessDate value={date} onChange={setDate} />
          <Field label="メモ（任意）">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </Field>
          <div className="sticky-actions">
            <button className="btn btn-primary btn-block" disabled={!canConfirm || p.status !== 'placed'} onClick={() => setStep('confirm')}>
              確認へ進む
            </button>
          </div>
        </>
      )}
      {step === 'confirm' && (
        <>
          <div className="card">
            {chosen.map(([lid, splits]) => {
              const l = p.lines.find((x: any) => x.id === lid);
              return (
                <div key={lid} style={{ marginBottom: '0.6rem' }}>
                  <div>
                    <strong>{l.skuCode}</strong> {l.skuName} {variant(l.color, l.size)}
                  </div>
                  {splits.map((s, i) => {
                    const loc = (locs.data ?? []).find((x) => x.id === s.locationId);
                    return <ChangePreview key={i} label={`${loc?.name}${loc?.kind === 'hold' ? '（保留：利用可能には含めません）' : ''}`} before={cur(l.skuId, s.locationId)} delta={s.qty ?? 0} unit={l.unit} />;
                  })}
                  <div className="small">
                    発注受領 +{total(lid)}（受領済 {l.received} → {l.received + total(lid)}）／ 未入荷 {l.outstanding} → {closeShort[lid] ? '0（残数打切り）' : l.outstanding - total(lid)}
                  </div>
                </div>
              );
            })}
          </div>
          <CmdStatus state={cmd.state} onCheck={cmd.check} onResend={cmd.resend} />
          <div className="sticky-actions">
            {!online ? (
              <p className="msg msg-warn">オフラインのため確定できません。通信できる場所で確定してください。</p>
            ) : (
              <div className="btn-row">
                <button className="btn" onClick={() => setStep('input')} disabled={['sending', 'unknown'].includes(cmd.state.phase)}>
                  戻って修正
                </button>
                <button
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  disabled={['sending', 'unknown', 'checking'].includes(cmd.state.phase)}
                  onClick={() =>
                    cmd.submit({
                      businessDate: date,
                      note,
                      lines: chosen.map(([lid, s]) => ({ poLineId: lid, splits: s.map((x) => ({ locationId: x.locationId, qty: x.qty })) })),
                      closeShortLineIds: shortIds.filter((x) => sel[x]),
                      closeShortReason: closeReason,
                      expected: chosen.flatMap(([lid, s]) => {
                        const l = p.lines.find((x: any) => x.id === lid);
                        return s.map((x) => ({ skuId: l.skuId, locationId: x.locationId, qty: cur(l.skuId, x.locationId) }));
                      }),
                    })
                  }
                >
                  入荷を確定する
                </button>
              </div>
            )}
          </div>
        </>
      )}
      {scan && (
        <Scanner
          onClose={() => setScan(false)}
          onDetected={async (text) => {
            setScan(false);
            const r = await get<any>(`/api/resolve${qs({ code: text })}`).catch(() => null);
            const hit = r?.type === 'sku' ? open.find((l: any) => l.skuId === r.skuId) : null;
            if (hit) {
              if (!sel[hit.id]) setSel({ ...sel, [hit.id]: [{ locationId: hit.locationId, qty: null }] });
              setScanMsg(`${hit.skuCode} ${hit.skuName} を選びました。数量を入力してください（読み取りで数量は加算しません）。`);
            } else setScanMsg('この発注の未入荷明細に該当する商品ではありません');
          }}
        />
      )}
    </div>
  );
}

// ---------- 顧客返品 ----------
export function CustomerReturn() {
  const locs = useLocations();
  const cmd = useCommand('/api/ops/customer-return');
  const [sku, setSku] = useState<SkuHit | null>(null);
  const [src, setSrc] = useState<string>('');
  const [noSource, setNoSource] = useState(false);
  const [loc, setLoc] = useState('');
  const [qty, setQty] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayTokyo());
  const issues = useFetch<any>(sku ? `/api/history${qs({ skuId: sku.id, limit: 50 })}` : null, [sku?.id]);
  const issueRows = (issues.data?.rows ?? []).filter((r: any) => r.kind === 'issue_sale' || r.kind === 'issue_other');
  const holdLocs = (locs.data ?? []).filter((l) => l.kind === 'hold');
  useEffect(() => {
    if (!loc && holdLocs[0]) setLoc(holdLocs[0].id);
  }, [holdLocs, loc]);
  const valid = sku && loc && qty && (noSource ? reason.trim() : src);
  return (
    <div>
      <h1>顧客返品</h1>
      <p className="small muted">戻った商品は、いったん検品保留の場所へ入庫します（良品数量には自動で加算しません）。検品後に通常場所へ移動してください。</p>
      {cmd.state.phase === 'done' ? (
        <>
          <CmdStatus state={cmd.state} onCheck={cmd.check} onResend={cmd.resend} />
          <ResultLines result={cmd.state.result} />
          <Link to="/transfer" className="btn">
            検品後に通常場所へ移動する
          </Link>
        </>
      ) : (
        <>
          {holdLocs.length === 0 && (
            <p className="msg msg-warn">
              保留の場所がありません。<Link to="/locations">保管場所</Link>で種類「保留」の場所を作成してください。
            </p>
          )}
          {!sku ? <SkuPicker onPick={setSku} /> : <SkuCard s={sku} onClear={() => (setSku(null), setSrc(''))} />}
          {sku && (
            <>
              <h2>元の出庫</h2>
              <label className="check">
                <input type="checkbox" checked={noSource} onChange={(e) => setNoSource(e.target.checked)} /> 履歴にない過去の出荷（元履歴なし返品として登録）
              </label>
              {!noSource && (
                <Field label="元の出庫履歴">
                  <select value={src} onChange={(e) => setSrc(e.target.value)}>
                    <option value="">選択してください</option>
                    {issueRows.map((r: any) => (
                      <option key={r.id} value={r.id}>
                        {r.businessDate} {r.opNo} {r.location.name} {Math.abs(r.qty)}
                        {r.sku.unit}
                        {r.externalRef ? ` 参照${r.externalRef}` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <LocationSelect locations={locs.data ?? []} value={loc} onChange={setLoc} label="入庫先（保留場所）" filter={(l) => l.kind === 'hold'} />
              <QtyInput label="戻った数量" unit={sku.unit} value={qty} onChange={setQty} />
              {loc && qty ? <ChangePreview before={sku.locations.find((x) => x.locationId === loc)?.qty ?? 0} delta={qty} unit={sku.unit} label="保留場所" /> : null}
              <Field label={`理由${noSource ? '（必須）' : '（任意）'}`}>
                <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
              </Field>
              <BusinessDate value={date} onChange={setDate} />
              <CmdStatus state={cmd.state} onCheck={cmd.check} onResend={cmd.resend} />
              <button
                className="btn btn-primary btn-block"
                disabled={!valid || ['sending', 'unknown', 'checking'].includes(cmd.state.phase)}
                onClick={() => cmd.submit({ sourceEventId: noSource ? null : src, skuId: sku.id, locationId: loc, qty, reason, businessDate: date, note: '', externalRef: '' })}
              >
                返品入庫を確定する
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------- 仕入先返品 ----------
export function SupplierReturn() {
  const locs = useLocations();
  const cmd = useCommand('/api/ops/supplier-return');
  const [sku, setSku] = useState<SkuHit | null>(null);
  const [src, setSrc] = useState('');
  const [loc, setLoc] = useState('');
  const [qty, setQty] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayTokyo());
  const rec = useFetch<any>(sku ? `/api/history${qs({ skuId: sku.id, limit: 100 })}` : null, [sku?.id]);
  const rows = (rec.data?.rows ?? []).filter((r: any) => r.kind === 'po_receipt' || r.kind === 'outside_receipt');
  const cur = sku?.locations.find((x) => x.locationId === loc)?.qty ?? 0;
  return (
    <div>
      <h1>仕入先返品</h1>
      <p className="small muted">受領した商品を仕入先へ返送した数量を減らします。発注の受領数・発注残は変わらず、追加の発注も自動では作りません（再送品は交換用の発注を作成してください）。</p>
      {cmd.state.phase === 'done' ? (
        <>
          <CmdStatus state={cmd.state} onCheck={cmd.check} onResend={cmd.resend} />
          <ResultLines result={cmd.state.result} />
        </>
      ) : (
        <>
          {!sku ? <SkuPicker onPick={setSku} /> : <SkuCard s={sku} onClear={() => setSku(null)} />}
          {sku && (
            <>
              <Field label="元の受領（入荷）">
                <select value={src} onChange={(e) => setSrc(e.target.value)}>
                  <option value="">選択してください</option>
                  {rows.map((r: any) => (
                    <option key={r.id} value={r.id}>
                      {r.businessDate} {r.opNo} {r.poNo ?? '発注外'} {r.location.name} +{r.qty}
                    </option>
                  ))}
                </select>
              </Field>
              <LocationSelect locations={locs.data ?? []} value={loc} onChange={setLoc} label="現物を返す場所" qtyOf={(id) => sku.locations.find((x) => x.locationId === id)?.qty ?? 0} unit={sku.unit} />
              <QtyInput label="返品数量" unit={sku.unit} value={qty} onChange={setQty} />
              {loc && qty ? <ChangePreview before={cur} delta={-qty} unit={sku.unit} /> : null}
              <Field label="理由（必須）">
                <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
              </Field>
              <BusinessDate value={date} onChange={setDate} />
              <CmdStatus state={cmd.state} onCheck={cmd.check} onResend={cmd.resend} />
              <button
                className="btn btn-primary btn-block"
                disabled={!src || !loc || !qty || !reason.trim() || ['sending', 'unknown', 'checking'].includes(cmd.state.phase)}
                onClick={() => cmd.submit({ sourceEventId: src, locationId: loc, qty, reason, businessDate: date, note: '', externalRef: '', expected: [{ skuId: sku.id, locationId: loc, qty: cur }] })}
              >
                仕入先返品を確定する
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
