import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, del, get, post, put, qs } from '../lib/api';
import { useApp } from '../lib/app-context';
import { useCommand } from '../lib/useCommand';
import { CmdStatus, Empty, ErrorMsg, Field, LocationSelect, Loading, QtyInput, SkuPicker, todayTokyo, useFetch, useLocations, variant, fmtDateTime, type SkuHit } from '../components/ui';
import { DocumentActions } from './Docs';

const STATUS_CHIPS: [string, string][] = [
  ['all', 'すべて'],
  ['draft', '下書き'],
  ['open', '入荷待ち'],
  ['closed', '完了'],
];

export function PoList() {
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? 'all';
  const { me } = useApp();
  const { data, error, loading } = useFetch<any[]>(`/api/pos${qs({ status, q: sp.get('q'), overdue: sp.get('overdue') ? 1 : undefined, limit: 100 })}`, [me?.dataEpoch]);
  return (
    <div>
      <div className="row" style={{ alignItems: 'center' }}>
        <h1 style={{ flex: 1 }}>発注</h1>
        <Link to="/pos/new" className="btn btn-small" style={{ flex: '0 0 auto' }}>
          ＋ 手動で発注下書き
        </Link>
      </div>
      <p className="small muted">発注書は商品・数量・希望納期・納入場所だけの数量発注書です。金額・税・支払は扱いません。</p>
      <div className="chips">
        {STATUS_CHIPS.map(([v, l]) => (
          <button key={v} className={`chip ${status === v ? 'on' : ''}`} onClick={() => setSp(qs({ status: v }).slice(1))}>
            {l}
          </button>
        ))}
        <button className={`chip ${sp.get('overdue') ? 'on' : ''}`} onClick={() => setSp(qs({ status, overdue: sp.get('overdue') ? '' : '1' }).slice(1))}>
          納期超過
        </button>
      </div>
      {loading && <Loading />}
      <ErrorMsg error={error} />
      {data?.length === 0 && <Empty>発注はありません</Empty>}
      <div className="cards">
        {data?.map((p) => (
          <Link key={p.id} to={`/pos/${p.id}`} className="item">
            <div style={{ flex: 1 }}>
              <div>
                <strong>{p.poNo}</strong> {p.supplierName}
              </div>
              <div className="small">
                <span className={`badge ${p.displayStatus === 'draft' ? '' : p.displayStatus === 'partial' ? 'badge-warn' : p.displayStatus === 'received' ? 'badge-ok' : ''}`}>{p.displayStatusLabel}</span>{' '}
                {p.overdue && <span className="badge badge-err">納期超過</span>} 明細{p.lineCount} ／ 発注{p.qty} 受領{p.received} 打切{p.cancelled} ／ 残 <strong>{p.outstanding}</strong>
              </div>
              <div className="small muted">
                作成 {p.createdDate} {p.orderedDate && `／ 発注 ${p.orderedDate}`} {p.nextDue && `／ 次の納期 ${p.nextDue}`}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function PoDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: p, error, loading, reload } = useFetch<any>(`/api/pos/${id}`);
  const placeCmd = useCommand(`/api/pos/${id}/place`);
  const cancelCmd = useCommand(`/api/pos/${id}/cancel-remaining`);
  const [orderedDate, setOrderedDate] = useState(todayTokyo());
  const [basisChanged, setBasisChanged] = useState<any[] | null>(null);
  const [cancelSel, setCancelSel] = useState<Record<string, boolean>>({});
  const [cancelReason, setCancelReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (placeCmd.state.phase === 'error' && placeCmd.state.error.code === 'BASIS_CHANGED') setBasisChanged(placeCmd.state.error.details.changed);
    if (placeCmd.state.phase === 'done' || cancelCmd.state.phase === 'done') reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeCmd.state.phase, cancelCmd.state.phase]);
  if (loading && !p) return <Loading />;
  if (error) return <ErrorMsg error={error} />;
  if (!p) return null;
  const openLines = p.lines.filter((l: any) => l.outstanding > 0);
  return (
    <div>
      <h1>
        {p.poNo} <span className="badge">{p.displayStatusLabel}</span>
      </h1>
      <div className="card small">
        <dl className="kv">
          <dt>仕入先</dt>
          <dd>{p.supplierName}</dd>
          <dt>作成日／発注日</dt>
          <dd>
            {p.createdDate} ／ {p.orderedDate ?? '未発注'}
          </dd>
          <dt>希望納期</dt>
          <dd>{p.dueDate ?? '明細ごと'}</dd>
          <dt>外部注文番号</dt>
          <dd>{p.externalRef || '—'}</dd>
          <dt>仕入先向け備考</dt>
          <dd>{p.supplierNote || '—'}</dd>
          <dt>内部メモ（帳票に出ない）</dt>
          <dd>{p.internalMemo || '—'}</dd>
          {p.replacesPoId && (
            <>
              <dt>交換元の発注</dt>
              <dd>
                <Link to={`/pos/${p.replacesPoId}`}>表示</Link>
              </dd>
            </>
          )}
        </dl>
      </div>
      <div className="table-wrap">
        <table className="list">
          <thead>
            <tr>
              <th>#</th>
              <th>商品</th>
              <th className="num">発注Q</th>
              <th className="num">受領R</th>
              <th className="num">打切C</th>
              <th className="num">残O</th>
              <th>納期・納入場所</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l: any) => (
              <tr key={l.id}>
                <td>{l.lineNo}</td>
                <td>
                  <Link to={`/skus/${l.skuId}`}>{l.skuCode}</Link> {l.skuName} <span className="small muted">{variant(l.color, l.size)}</span>
                </td>
                <td className="num">
                  {l.qty} {l.unit}
                </td>
                <td className="num">{l.received}</td>
                <td className="num">{l.cancelled}</td>
                <td className="num">
                  <strong>{p.status === 'draft' ? '—' : l.outstanding}</strong>
                </td>
                <td className="small">
                  {l.dueDate ?? p.dueDate ?? '—'} ／ {l.locationName}
                  {l.locationKind === 'hold' && '（保留）'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">残O＝発注Q−受領R−打切C。発注残0でも打切りがある場合は「入荷完了」ではなく「残数打切り完了」です。</p>
      <ErrorMsg error={err} />
      <DocumentActions create={() => post(`/api/pos/${p.id}/sheet`)} label="数量発注書PDF" note="PDFを作成・共有しても「発注済み」にはなりません。" />
      {p.status === 'draft' && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>発注済みにする</h2>
          <p className="small">仕入先への発注（メール・電話・Webなど）を実際に行ったことを記録します。アプリから仕入先へは送信しません。</p>
          <Field label="発注日">
            <input type="date" value={orderedDate} onChange={(e) => setOrderedDate(e.target.value)} />
          </Field>
          {basisChanged && (
            <div className="msg msg-warn">
              下書き作成後に在庫・発注残が変わりました：
              <ul>
                {basisChanged.map((c) => (
                  <li key={c.skuId}>
                    {c.skuCode} {c.skuName}：作成時の補充判断数量 {c.basisAtDraft} → 現在 {c.currentP}（利用可能 {c.available}、発注残 {c.onOrder}）／下書き数量 {c.draftQty}
                  </li>
                ))}
              </ul>
              数量を見直す場合は「下書きを編集」してください。このままで良ければ下のボタンで確定します。
            </div>
          )}
          <CmdStatus state={placeCmd.state.phase === 'error' && placeCmd.state.error.code === 'BASIS_CHANGED' ? { phase: 'idle' } : placeCmd.state} onCheck={placeCmd.check} onResend={placeCmd.resend} />
          <div className="btn-row">
            <Link to={`/pos/${p.id}/edit`} className="btn">
              下書きを編集
            </Link>
            <button
              className="btn btn-primary"
              disabled={p.lines.length === 0 || ['sending', 'unknown', 'checking'].includes(placeCmd.state.phase)}
              onClick={() =>
                placeCmd.submit({
                  version: p.version,
                  orderedDate,
                  acknowledgedBasis: basisChanged ? Object.fromEntries(basisChanged.map((c) => [c.skuId, c.currentP])) : {},
                })
              }
            >
              {basisChanged ? '最新の数量を確認した上で発注済みにする' : '発注済みにする'}
            </button>
            <button
              className="btn btn-danger"
              onClick={async () => {
                if (!confirm('この下書きを削除しますか？')) return;
                try {
                  await del(`/api/pos/${p.id}`);
                  nav('/pos');
                } catch (e) {
                  setErr(e);
                }
              }}
            >
              下書きを削除
            </button>
          </div>
        </div>
      )}
      {p.status === 'placed' && (
        <div className="btn-row">
          {openLines.length > 0 && (
            <Link to={`/receive/${p.id}`} className="btn btn-primary">
              入荷を登録
            </Link>
          )}
          <Link to={`/pos/${p.id}/revise`} className="btn">
            発注内容の訂正（理由付き）
          </Link>
          <Link to={`/pos/new?replaces=${p.id}&supplierId=${p.supplierId}`} className="btn">
            交換用の発注を作成
          </Link>
        </div>
      )}
      {p.status === 'placed' && openLines.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>未入荷分の打切り</h2>
          <p className="small">仕入先に確認し、届かないことが決まった残数を打ち切ります。既に届いた現物は減りません（返送は「仕入先返品」）。</p>
          {openLines.map((l: any) => (
            <label key={l.id} className="check">
              <input type="checkbox" checked={!!cancelSel[l.id]} onChange={(e) => setCancelSel({ ...cancelSel, [l.id]: e.target.checked })} />
              <span>
                {l.skuCode} {l.skuName}：残 {l.outstanding} を打ち切る
              </span>
            </label>
          ))}
          <Field label="理由（必須）">
            <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={500} />
          </Field>
          <CmdStatus state={cancelCmd.state} onCheck={cancelCmd.check} onResend={cancelCmd.resend} />
          <button
            className="btn btn-danger"
            disabled={!Object.values(cancelSel).some(Boolean) || !cancelReason.trim() || ['sending', 'unknown'].includes(cancelCmd.state.phase)}
            onClick={() => cancelCmd.submit({ version: p.version, reason: cancelReason, lineIds: Object.entries(cancelSel).filter(([, v]) => v).map(([k]) => k) })}
          >
            残数を打ち切る
          </button>
        </div>
      )}
      {p.receipts.length > 0 && (
        <>
          <h2>受領履歴</h2>
          <div className="table-wrap">
            <table className="list">
              <thead>
                <tr>
                  <th>伝票</th>
                  <th>受領日</th>
                  <th>商品</th>
                  <th>場所</th>
                  <th className="num">数量</th>
                </tr>
              </thead>
              <tbody>
                {p.receipts.map((r: any) => (
                  <tr key={r.eventId}>
                    <td>
                      <Link to={`/ops/${r.opId}`}>{r.opNo}</Link>
                    </td>
                    <td>{r.businessDate}</td>
                    <td>{p.lines.find((l: any) => l.id === r.poLineId)?.skuCode}</td>
                    <td>{r.locationName}</td>
                    <td className={`num ${r.qty > 0 ? 'plus' : 'minus'}`}>
                      {r.qty > 0 ? `+${r.qty}` : r.qty}
                      {r.kind === 'reversal' && ' 取消'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {p.revisions.length > 0 && (
        <>
          <h2>版の履歴</h2>
          <ul className="small">
            {p.revisions.map((r: any, i: number) => (
              <li key={i}>
                {fmtDateTime(r.created_at)} 版{r.version}：{{ placed: '発注済み', revised: '訂正', cancel_remaining: '残数打切り' }[r.action as string] ?? r.action}
                {r.reason && `（${r.reason}）`}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

interface EditLine {
  id?: string;
  sku: { id: string; code: string; name: string; unit: string; color?: string; size?: string };
  qty: number | null;
  dueDate: string;
  locationId: string;
  received?: number;
  cancelled?: number;
  basisP?: number | null;
}

/** 下書きの作成・編集、発注済みの訂正（mode=revise） */
export function PoEdit({ mode }: { mode: 'new' | 'edit' | 'revise' }) {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const sups = useFetch<any[]>('/api/suppliers');
  const locs = useLocations();
  const [supplierId, setSupplierId] = useState(sp.get('supplierId') ?? '');
  const [dueDate, setDueDate] = useState('');
  const [locationId, setLocationId] = useState('');
  const [externalRef, setExternalRef] = useState('');
  const [supplierNote, setSupplierNote] = useState('');
  const [internalMemo, setInternalMemo] = useState('');
  const [lines, setLines] = useState<EditLine[]>([]);
  const [version, setVersion] = useState(1);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const reviseCmd = useCommand(`/api/pos/${id}/revise`);
  useEffect(() => {
    if (!id) return;
    get<any>(`/api/pos/${id}`).then((p) => {
      setSupplierId(p.supplierId);
      setDueDate(p.dueDate ?? '');
      setLocationId(p.locationId ?? '');
      setExternalRef(p.externalRef);
      setSupplierNote(p.supplierNote);
      setInternalMemo(p.internalMemo);
      setVersion(p.version);
      setLines(
        p.lines.map((l: any) => ({
          id: mode === 'revise' ? l.id : undefined,
          sku: { id: l.skuId, code: l.skuCode, name: l.skuName, unit: l.unit, color: l.color, size: l.size },
          qty: l.qty,
          dueDate: l.dueDate ?? '',
          locationId: l.locationId,
          received: l.received,
          cancelled: l.cancelled,
          basisP: l.basisP,
        })),
      );
    }, setErr);
  }, [id, mode]);
  useEffect(() => {
    if (reviseCmd.state.phase === 'done') nav(`/pos/${id}`);
  }, [reviseCmd.state.phase, id, nav]);
  const normalLocs = (locs.data ?? []).filter((l) => !l.archived);
  const addSku = (s: SkuHit) => setLines([...lines, { sku: s, qty: null, dueDate: '', locationId: locationId || normalLocs.find((l) => l.kind === 'normal')?.id || '' }]);
  const valid = supplierId && lines.every((l) => l.qty && l.locationId) && (mode !== 'revise' || (reason.trim() && lines.length > 0));
  const payloadLines = () => lines.map((l) => ({ id: l.id, skuId: l.sku.id, qty: l.qty, dueDate: l.dueDate || null, locationId: l.locationId, basisP: l.basisP ?? null }));
  return (
    <div>
      <h1>{mode === 'new' ? '発注下書きを作成' : mode === 'edit' ? '発注下書きを編集' : '発注内容の訂正'}</h1>
      {mode === 'revise' && <p className="msg msg-info small">発注済みの内容は版と理由を残して訂正します。既存の明細は削除できません（数量を減らすか、残数を打ち切ります）。</p>}
      {sp.get('replaces') && <p className="msg msg-info small">交換用の発注として、元の発注に関連付けます。</p>}
      <div className="card">
        <Field label="仕入先">
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} disabled={mode === 'revise'}>
            <option value="">選択してください</option>
            {(sups.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="row">
          <Field label="希望納期（全体）">
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          {mode !== 'revise' && (
            <LocationSelect locations={normalLocs} value={locationId} onChange={setLocationId} label="納入場所（全体）" />
          )}
        </div>
        <Field label="外部注文番号（任意）">
          <input value={externalRef} onChange={(e) => setExternalRef(e.target.value)} maxLength={100} />
        </Field>
        <Field label="仕入先向け備考（発注書に表示）">
          <textarea value={supplierNote} onChange={(e) => setSupplierNote(e.target.value)} maxLength={1000} />
        </Field>
        <Field label="内部メモ（発注書に出ません）">
          <textarea value={internalMemo} onChange={(e) => setInternalMemo(e.target.value)} maxLength={2000} />
        </Field>
      </div>
      <h2>明細</h2>
      <SkuPicker onPick={addSku} />
      {lines.map((l, i) => (
        <div key={i} className="card">
          <div>
            <strong>{l.sku.code}</strong> {l.sku.name} {variant(l.sku.color, l.sku.size)}
            {l.id && (
              <span className="small muted">
                {' '}
                （受領済 {l.received}／打切 {l.cancelled}）
              </span>
            )}
          </div>
          <QtyInput label="発注数量" unit={l.sku.unit} value={l.qty} min={l.id ? Math.max(1, (l.received ?? 0) + (l.cancelled ?? 0)) : 1} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: v } : x)))} />
          <div className="row">
            <Field label="希望納期（明細）">
              <input type="date" value={l.dueDate} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)))} />
            </Field>
            <LocationSelect locations={normalLocs} value={l.locationId} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, locationId: v } : x)))} label="納入場所" />
          </div>
          {!l.id && (
            <button className="btn btn-small" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
              明細を削除
            </button>
          )}
        </div>
      ))}
      {mode === 'revise' && (
        <Field label="訂正の理由（必須）">
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
      )}
      <ErrorMsg error={err} />
      {mode === 'revise' && <CmdStatus state={reviseCmd.state} onCheck={reviseCmd.check} onResend={reviseCmd.resend} />}
      <div className="sticky-actions">
        <button
          className="btn btn-primary btn-block"
          disabled={!valid || busy}
          onClick={async () => {
            setErr(null);
            if (mode === 'revise') {
              reviseCmd.submit({ version, reason, dueDate: dueDate || null, externalRef, supplierNote, internalMemo, lines: payloadLines() });
              return;
            }
            setBusy(true);
            const body = {
              supplierId,
              dueDate: dueDate || null,
              locationId: locationId || null,
              externalRef,
              supplierNote,
              internalMemo,
              replacesPoId: sp.get('replaces'),
              lines: payloadLines().map((l) => ({ ...l, id: undefined })),
            };
            try {
              if (mode === 'new') {
                const r = await post<{ id: string }>('/api/pos', body);
                nav(`/pos/${r.id}`);
              } else {
                await put(`/api/pos/${id}`, { ...body, version });
                nav(`/pos/${id}`);
              }
            } catch (e) {
              setErr(e instanceof ApiError && e.code === 'VERSION_CONFLICT' ? new Error(`${e.message}`) : e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {mode === 'revise' ? '訂正を確定する' : '下書きを保存'}
        </button>
      </div>
    </div>
  );
}

// ---------- 補充候補 ----------
export function Replenish() {
  const { me } = useApp();
  const [filter, setFilter] = useState<'candidates' | 'all' | 'unconfigured'>('candidates');
  const { data, error, loading, reload } = useFetch<any[]>(`/api/replenish?filter=${filter}`, [me?.dataEpoch]);
  const locs = useLocations();
  const [sel, setSel] = useState<Record<string, { qty: number | null; on: boolean }>>({});
  const cmd = useCommand('/api/replenish/drafts');
  const [deliveryLoc, setDeliveryLoc] = useState('');
  const defaultLoc = deliveryLoc || ((locs.data ?? []).find((l) => l.kind === 'normal' && !l.archived)?.id ?? '');
  useEffect(() => {
    if (!data) return;
    const n: Record<string, { qty: number | null; on: boolean }> = {};
    for (const r of data) n[r.skuId] = sel[r.skuId] ?? { qty: r.recommended || null, on: false };
    setSel(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const chosen = (data ?? []).filter((r) => sel[r.skuId]?.on);
  const noSupplier = chosen.filter((r) => !r.supplierId);
  return (
    <div>
      <h1>補充</h1>
      <p className="small muted">
        補充判断数量 P ＝ 利用可能（通常場所）＋ 通常場所への発注残。P が発注点以下なら、目標在庫までの不足を最小発注数量・発注単位に合わせて推奨します。推奨は補助で、自動発注やAI予測はしません。下書きは在庫を予約せず、発注残にも含めません。
      </p>
      <div className="chips">
        {(
          [
            ['candidates', '要確認（補充・安全在庫割れ・納期超過）'],
            ['all', 'すべて'],
            ['unconfigured', '補充設定なし'],
          ] as const
        ).map(([v, l]) => (
          <button key={v} className={`chip ${filter === v ? 'on' : ''}`} onClick={() => setFilter(v)}>
            {l}
          </button>
        ))}
      </div>
      <LocationSelect locations={locs.data ?? []} value={defaultLoc} onChange={setDeliveryLoc} label="納入場所" filter={(l) => l.kind === 'normal'} />
      {loading && <Loading />}
      <ErrorMsg error={error} />
      {data?.length === 0 && <Empty>該当するSKUはありません</Empty>}
      <div className="cards">
        {data?.map((r) => (
          <div key={r.skuId} className="card">
            <label className="check">
              <input
                type="checkbox"
                checked={!!sel[r.skuId]?.on}
                disabled={!r.configured && !sel[r.skuId]?.qty}
                onChange={(e) => setSel({ ...sel, [r.skuId]: { ...sel[r.skuId], on: e.target.checked } })}
              />
              <span>
                <strong>{r.skuCode}</strong> {r.skuName} {variant(r.color, r.size)}
              </span>
            </label>
            <div className="small">
              利用可能 <strong>{r.available}</strong> ／ 保留 {r.hold} ／ 発注残 {r.onOrder} ／ <strong>P {r.p}</strong>
              {r.configured && (
                <>
                  {' '}
                  ／ 発注点 {r.reorderPoint}・目標 {r.targetStock}・単位 {r.orderMultiple}
                  {r.minOrderQty > 0 && `・最小 ${r.minOrderQty}`}
                </>
              )}
            </div>
            <div className="small">
              {r.belowSafety && <span className="badge badge-err">安全在庫割れ（手元不足）</span>} {r.overdueOnOrder > 0 && <span className="badge badge-err">納期超過の発注残 {r.overdueOnOrder}</span>}{' '}
              {r.draftQty > 0 && <span className="badge badge-warn">既存下書き {r.draftQty}（{r.draftPoNos.join('、')}）</span>} {r.reason}
            </div>
            <div className="small muted">
              場所別：{r.locations.map((l: any) => `${l.name}${l.kind === 'hold' ? '(保留)' : ''} ${l.qty}`).join('、') || 'なし'} ／ 仕入先 {r.supplierName ?? '未設定'}
              {r.suggestedDueDate && ` ／ 納期目安 ${r.suggestedDueDate}（リードタイム${r.leadTimeDays}日を暦日で加算）`}
            </div>
            {r.overdueOnOrder > 0 && <div className="small">納期超過の発注は自動で消しません。<Link to={`/receive?skuId=${r.skuId}&overdue=1`}>既存の発注を確認</Link>し、打切りまたは理由を付けて追加発注を判断してください。</div>}
            {sel[r.skuId]?.on && (
              <QtyInput label={`発注数量（推奨 ${r.recommended}）`} unit={r.unit} value={sel[r.skuId]?.qty ?? null} onChange={(v) => setSel({ ...sel, [r.skuId]: { ...sel[r.skuId], qty: v } })} />
            )}
          </div>
        ))}
      </div>
      {cmd.state.phase === 'done' ? (
        <div className="msg msg-ok">
          仕入先別に発注下書きを作成しました：
          {cmd.state.result.created.map((c: any) => (
            <div key={c.poId}>
              <Link to={`/pos/${c.poId}`}>{c.poNo}</Link>（{c.lines}明細）
            </div>
          ))}
          <button className="btn btn-small" onClick={() => (cmd.reset(), reload())}>
            候補を再読み込み
          </button>
        </div>
      ) : (
        <>
          {noSupplier.length > 0 && <p className="msg msg-warn">標準仕入先が未設定のSKUがあります（{noSupplier.map((r) => r.skuCode).join('、')}）。商品の編集で仕入先を設定してください。</p>}
          <CmdStatus state={cmd.state} onCheck={cmd.check} onResend={cmd.resend} />
          {cmd.state.phase === 'error' && cmd.state.error.code === 'BASIS_CHANGED' && (
            <button className="btn" onClick={() => (cmd.reset(), reload())}>
              候補を再読み込みする
            </button>
          )}
          <div className="sticky-actions">
            <button
              className="btn btn-primary btn-block"
              disabled={!chosen.length || noSupplier.length > 0 || chosen.some((r) => !sel[r.skuId]?.qty) || !defaultLoc || ['sending', 'unknown', 'checking'].includes(cmd.state.phase)}
              onClick={() =>
                cmd.submit({
                  items: chosen.map((r) => ({ skuId: r.skuId, supplierId: r.supplierId, qty: sel[r.skuId].qty, locationId: defaultLoc, dueDate: r.suggestedDueDate, basisP: r.p })),
                })
              }
            >
              選択した{chosen.length}件で仕入先別の発注下書きを作る
            </button>
          </div>
        </>
      )}
    </div>
  );
}
