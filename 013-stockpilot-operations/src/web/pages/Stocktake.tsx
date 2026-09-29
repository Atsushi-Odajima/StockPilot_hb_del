import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, post } from '../lib/api';
import { useApp } from '../lib/app-context';
import { useCommand } from '../lib/useCommand';
import { CmdStatus, Empty, ErrorMsg, Field, LocationSelect, Loading, Photo, SkuPicker, todayTokyo, useFetch, useLocations, variant, fmtDateTime } from '../components/ui';
import { DocumentActions } from './Docs';

const STATUS: Record<string, string> = { counting: '計数中', review: '差異確認', confirmed: '確定', cancelled: '中止' };
const REASONS: [string, string][] = [
  ['miscount', '過去の数え間違い'],
  ['unrecorded_in', '入庫の記録漏れ'],
  ['unrecorded_out', '出庫の記録漏れ'],
  ['damage', '破損・劣化'],
  ['loss', '紛失・不明'],
  ['found', '見つかった'],
  ['other', 'その他（メモ必須）'],
];

export function StocktakeList() {
  const { me } = useApp();
  const list = useFetch<any[]>('/api/stocktakes', [me?.dataEpoch]);
  const locs = useLocations();
  const cmd = useCommand('/api/stocktakes');
  const nav = useNavigate();
  const [loc, setLoc] = useState('');
  const [date, setDate] = useState(todayTokyo());
  return (
    <div>
      <h1>棚卸</h1>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>新しく棚卸を始める</h2>
        <p className="small">
          選んだ場所を<strong>一時的に入出庫停止</strong>して数えます（他の場所の業務は続けられます）。確定または中止するまで、この場所への入庫・出庫・移動・返品・訂正はできません。
        </p>
        <LocationSelect locations={locs.data ?? []} value={loc} onChange={setLoc} label="対象の場所" />
        <Field label="棚卸日">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <CmdStatus state={cmd.state} onCheck={cmd.check} onResend={cmd.resend} />
        <button
          className="btn btn-primary btn-block"
          disabled={!loc || ['sending', 'unknown', 'checking'].includes(cmd.state.phase)}
          onClick={async () => {
            const r = await cmd.submit({ locationId: loc, businessDate: date });
            if (r) nav(`/stocktakes/${r.result.id}`);
          }}
        >
          この場所を停止して棚卸を開始
        </button>
      </div>
      <h2>棚卸の一覧</h2>
      {list.loading && <Loading />}
      <ErrorMsg error={list.error} />
      {list.data?.length === 0 && <Empty>棚卸はまだありません</Empty>}
      <div className="cards">
        {list.data?.map((s) => (
          <Link key={s.id} to={`/stocktakes/${s.id}`} className="item">
            <div>
              <strong>{s.stNo}</strong> {s.locationName} <span className={`badge ${s.status === 'counting' || s.status === 'review' ? 'badge-warn' : ''}`}>{STATUS[s.status]}</span>
              <div className="small muted">
                {s.businessDate} ／ 対象 {s.lines}件 {s.uncounted > 0 && s.status !== 'cancelled' && `／ 未計数 ${s.uncounted}件`}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function StocktakeSession() {
  const { id } = useParams();
  const { data: st, error, loading, reload, setData } = useFetch<any>(`/api/stocktakes/${id}`);
  const [showTheory, setShowTheory] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [outsideNote, setOutsideNote] = useState('');
  const [filter, setFilter] = useState<'all' | 'uncounted' | 'diff'>('all');
  const confirmCmd = useCommand(`/api/stocktakes/${id}/confirm`);
  const cancelCmd = useCommand(`/api/stocktakes/${id}/cancel`);
  if (loading && !st) return <Loading />;
  if (error) return <ErrorMsg error={error} />;
  if (!st) return null;
  const active = st.status === 'counting' || st.status === 'review';
  const uncounted = st.lines.filter((l: any) => l.counted === null).length;
  const diffs = st.lines.filter((l: any) => l.diff !== null && l.diff !== 0);
  const needReason = diffs.filter((l: any) => !l.reasonCode || (l.reasonCode === 'other' && !l.reasonNote.trim()));
  const updateLine = (lineId: string, patch: any) => setData({ ...st, lines: st.lines.map((l: any) => (l.id === lineId ? { ...l, ...patch } : l)) });
  const saveCount = async (l: any, v: number | null) => {
    setErr(null);
    try {
      const r = await post(`/api/stocktakes/${st.id}/count`, { lineId: l.id, version: l.version, countedQty: v });
      updateLine(l.id, { counted: v, diff: v === null ? null : v - l.theoretical, version: r.version, countEdits: l.countEdits + 1 });
      reload(); // 棚卸全体の版・状態（差異確認の解除）を最新にする
    } catch (e) {
      setErr(e);
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') reload();
    }
  };
  const saveReason = async (l: any, reasonCode: string | null, reasonNote: string) => {
    setErr(null);
    try {
      const r = await post(`/api/stocktakes/${st.id}/reason`, { lineId: l.id, version: l.version, reasonCode, reasonNote });
      updateLine(l.id, { reasonCode, reasonNote, version: r.version });
    } catch (e) {
      setErr(e);
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') reload();
    }
  };
  const lines = st.lines.filter((l: any) => filter === 'all' || (filter === 'uncounted' ? l.counted === null : l.diff !== null && l.diff !== 0));
  return (
    <div>
      <h1>
        {st.stNo} {st.locationName} <span className="badge badge-warn">{STATUS[st.status]}</span>
      </h1>
      <p className="small muted">
        開始 {fmtDateTime(st.startedAt)} ／ 棚卸日 {st.businessDate}
        {st.confirmedAt && ` ／ 確定 ${fmtDateTime(st.confirmedAt)}`}
        {st.cancelledAt && ` ／ 中止 ${fmtDateTime(st.cancelledAt)}（${st.cancelReason}）`}
      </p>
      {active && (
        <p className="msg msg-info small">
          この場所は棚卸のため入出庫停止中です。数を入力しただけでは在庫は変わりません。確定したときだけ差異を調整します。未計数の商品を0個とはみなしません。
        </p>
      )}
      <div className="chips">
        <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
          すべて {st.lines.length}
        </button>
        <button className={`chip ${filter === 'uncounted' ? 'on' : ''}`} onClick={() => setFilter('uncounted')}>
          未計数 {uncounted}
        </button>
        <button className={`chip ${filter === 'diff' ? 'on' : ''}`} onClick={() => setFilter('diff')}>
          差異あり {diffs.length}
        </button>
        <label className="check small" style={{ marginLeft: 'auto' }}>
          <input type="checkbox" checked={showTheory} onChange={(e) => setShowTheory(e.target.checked)} /> 理論在庫を表示
        </label>
      </div>
      <ErrorMsg error={err} />
      {lines.length === 0 && <Empty>該当する行はありません</Empty>}
      {lines.map((l: any) => (
        <div className="card" key={l.id}>
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <Photo fileId={l.photoFileId} alt={l.name} />
            <div style={{ flex: 1 }}>
              <div>
                <strong>{l.code}</strong> {l.name} {variant(l.color, l.size) && <span className="badge">{variant(l.color, l.size)}</span>}
              </div>
              <div className="small">
                {l.counted === null ? <span className="badge badge-warn">未計数</span> : <span className="badge badge-ok">計数済み {l.counted}</span>}
                {l.addedDuringCount && <span className="badge"> 棚卸中に追加</span>}
                {l.countEdits > 1 && <span className="muted"> 再計数 {l.countEdits - 1}回</span>}
                {(showTheory || !active) && (
                  <span>
                    {' '}
                    ／ 開始時理論 {l.theoretical}
                    {l.diff !== null && (
                      <strong className={l.diff === 0 ? '' : l.diff > 0 ? 'plus' : 'minus'}> 差異 {l.diff > 0 ? `+${l.diff}` : l.diff}</strong>
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>
          {active && (
            <>
              <CountInput key={`${l.id}-${l.version}`} unit={l.unit} value={l.counted} onSave={(v) => saveCount(l, v)} />
              {l.counted !== null && (
                <button className="btn btn-small" onClick={() => saveCount(l, null)}>
                  未計数に戻す
                </button>
              )}
              {st.status === 'review' && l.diff !== 0 && l.diff !== null && (
                <div className="row">
                  <Field label="差異の理由">
                    <select value={l.reasonCode ?? ''} onChange={(e) => saveReason(l, e.target.value || null, l.reasonNote)}>
                      <option value="">選択してください</option>
                      {REASONS.map(([v, t]) => (
                        <option key={v} value={v}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="メモ">
                    <input defaultValue={l.reasonNote} onBlur={(e) => e.target.value !== l.reasonNote && saveReason(l, l.reasonCode, e.target.value)} maxLength={500} />
                  </Field>
                </div>
              )}
            </>
          )}
          {!active && l.reasonCode && <div className="small">理由：{REASONS.find((r) => r[0] === l.reasonCode)?.[1]} {l.reasonNote}</div>}
        </div>
      ))}
      {active && (
        <>
          <button className="btn" onClick={() => setAddOpen(!addOpen)}>
            ＋ 一覧にない商品が見つかった
          </button>
          {addOpen && (
            <div className="card">
              <p className="small">登録済みの商品を追加します（別の入庫は作りません）。未登録の商品は、先に<Link to="/skus/new">商品登録</Link>してから追加してください。</p>
              <SkuPicker
                onPick={async (s) => {
                  setErr(null);
                  try {
                    await post(`/api/stocktakes/${st.id}/lines`, { skuId: s.id });
                    setAddOpen(false);
                    reload();
                  } catch (e) {
                    setErr(e);
                  }
                }}
              />
            </div>
          )}
        </>
      )}
      {st.status === 'counting' && (
        <div className="sticky-actions">
          <button
            className="btn btn-primary btn-block"
            disabled={uncounted > 0}
            onClick={async () => {
              setErr(null);
              try {
                await post(`/api/stocktakes/${st.id}/review`, { version: st.version });
                setShowTheory(true);
                reload();
              } catch (e) {
                setErr(e);
              }
            }}
          >
            {uncounted > 0 ? `未計数が${uncounted}件あります` : '差異を確認する'}
          </button>
        </div>
      )}
      {st.status === 'review' && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>差異の確定</h2>
          <p className="small">
            差異のある行 {diffs.length}件。確定すると差異の分だけ在庫を調整し、停止を解除します。{needReason.length > 0 && <strong className="minus">理由が未入力の行が{needReason.length}件あります。</strong>}
          </p>
          <CmdStatus state={confirmCmd.state} onCheck={confirmCmd.check} onResend={confirmCmd.resend} />
          <button
            className="btn btn-primary btn-block"
            disabled={needReason.length > 0 || ['sending', 'unknown', 'checking'].includes(confirmCmd.state.phase) || confirmCmd.state.phase === 'done'}
            onClick={async () => {
              const r = await confirmCmd.submit({ version: st.version });
              if (r) reload();
            }}
          >
            棚卸を確定する
          </button>
        </div>
      )}
      {active && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>棚卸の中止</h2>
          <p className="small">入力した実数は在庫に反映せず、停止を解除します。棚卸中にアプリ外で現物を動かしてしまった場合は、その事実を記録して中止し、不足している移動等を登録してから再棚卸してください。</p>
          <Field label="中止の理由（必須）">
            <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={500} />
          </Field>
          <Field label="アプリ外で動かした現物（任意）">
            <input value={outsideNote} onChange={(e) => setOutsideNote(e.target.value)} maxLength={1000} placeholder="例：イベント用に2個持ち出した" />
          </Field>
          <CmdStatus state={cancelCmd.state} onCheck={cancelCmd.check} onResend={cancelCmd.resend} />
          <button
            className="btn btn-danger"
            disabled={!cancelReason.trim() || ['sending', 'unknown', 'checking'].includes(cancelCmd.state.phase)}
            onClick={async () => {
              const r = await cancelCmd.submit({ reason: cancelReason, outsideMovementNote: outsideNote });
              if (r) reload();
            }}
          >
            棚卸を中止する
          </button>
        </div>
      )}
      {st.status === 'confirmed' && st.documentId && (
        <>
          <DocumentActions create={async () => ({ documentId: st.documentId })} label="棚卸差異PDF" />
          <a className="btn" href={`/api/export/stocktake?stocktakeId=${st.id}`}>
            差異CSVをダウンロード
          </a>
        </>
      )}
    </div>
  );
}

/** 実数入力：確定ボタン（またはEnter）で保存。0は明示入力、空欄は未計数 */
function CountInput({ value, unit, onSave }: { value: number | null; unit: string; onSave: (v: number) => void }) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [saving, setSaving] = useState(false);
  const ok = /^\d{1,10}$/.test(text) && Number(text) <= 1_000_000_000;
  const dirty = ok && Number(text) !== value;
  return (
    <form
      className="row"
      style={{ alignItems: 'flex-end' }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ok || !dirty) return;
        setSaving(true);
        await onSave(Number(text));
        setSaving(false);
      }}
    >
      <label className="field" style={{ flex: '1 1 140px', marginBottom: 0 }}>
        <span>実数（{unit}）</span>
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          value={text}
          onChange={(e) => setText(e.target.value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim())}
          style={{ textAlign: 'right', fontSize: '1.3rem', fontWeight: 700 }}
          aria-invalid={text !== '' && !ok}
        />
      </label>
      <button className="btn btn-primary" style={{ flex: '0 0 auto' }} disabled={!dirty || saving}>
        {saving ? '保存中' : value === null ? '記録' : '再計数を記録'}
      </button>
      {text !== '' && !ok && <small className="minus" style={{ flexBasis: '100%' }}>0以上の整数で入力してください</small>}
    </form>
  );
}
