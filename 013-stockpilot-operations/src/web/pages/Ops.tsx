import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { get, qs, lastServerContact } from '../lib/api';
import { useApp } from '../lib/app-context';
import { useCommand } from '../lib/useCommand';
import { saveDraft, getDraft, removeDraft, type DeviceDraft } from '../lib/drafts';
import {
  BusinessDate,
  ChangePreview,
  CmdStatus,
  ErrorMsg,
  Field,
  LocationSelect,
  Loading,
  QtyInput,
  SkuCard,
  SkuPicker,
  todayTokyo,
  useLocations,
  variant,
  type Loc,
  type SkuHit,
  fmtDateTime,
  Sheet,
  useFetch,
} from '../components/ui';
import { HistoryTable } from './Inventory';

export interface Line {
  sku: SkuHit;
  locationId: string;
  qty: number | null;
  direction?: 'increase' | 'decrease';
}

type OpKind = 'issue' | 'outside-receipt' | 'disposal' | 'correction' | 'initial';

const CONF: Record<OpKind, { title: string; url: string; sign: 1 | -1 | 0; normalOnly?: boolean; reason: 'required' | 'optional' | 'none'; purpose?: boolean; ref?: boolean; dest?: boolean; help: string }> = {
  issue: {
    title: '出庫',
    url: '/api/ops/issue',
    sign: -1,
    normalOnly: true,
    reason: 'none',
    purpose: true,
    ref: true,
    dest: true,
    help: '通常場所から出庫します。販売目的でも、売上金額や請求は作成しません。保留場所からは出庫できません。',
  },
  'outside-receipt': { title: '発注外入庫', url: '/api/ops/outside-receipt', sign: 1, reason: 'required', ref: true, help: '発注にない入庫です。既存の発注残は減りません。発注の入荷は「入庫（入荷待ち）」から行ってください。' },
  disposal: { title: '破損・廃棄', url: '/api/ops/disposal', sign: -1, reason: 'required', help: '実際に廃棄した数量を減らします。保管しておくだけなら、保留場所へ移動してください。' },
  correction: { title: '理由付き数量訂正', url: '/api/ops/correction', sign: 0, reason: 'required', help: '事実に基づいて数量を訂正します。誤登録そのものの取消は、履歴の「取消」から行ってください。' },
  initial: { title: '初期在庫', url: '/api/ops/initial', sign: 1, reason: 'none', help: '履歴のないSKU×場所に最初の数量を登録します。以後の数合わせには使えません（訂正・棚卸を使います）。' },
};

const PURPOSES: [string, string][] = [
  ['sale', '販売'],
  ['sample', 'サンプル配布'],
  ['business_use', '業務使用'],
  ['other', 'その他（持出し等）'],
];

function qtyAt(sku: SkuHit, locationId: string) {
  return sku.locations.find((l) => l.locationId === locationId)?.qty ?? 0;
}

async function loadSku(id: string): Promise<SkuHit> {
  const s = await get<any>(`/api/skus/${id}`);
  return {
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
  };
}

export function LinesOpPage({ kind }: { kind: OpKind }) {
  const c = CONF[kind];
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { me, online, account } = useApp();
  const locs = useLocations();
  const cmd = useCommand(c.url);
  const [lines, setLines] = useState<Line[]>([]);
  const [step, setStep] = useState<'input' | 'confirm'>('input');
  const [date, setDate] = useState(todayTokyo());
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [purpose, setPurpose] = useState('sale');
  const [ref, setRef] = useState('');
  const [dest, setDest] = useState('');
  const [defaultLoc, setDefaultLoc] = useState('');
  const [draftMsg, setDraftMsg] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // 端末下書きの再開：同じ操作キーで送る。最新の数量を読み直してから確認させる
  useEffect(() => {
    const d = sp.get('draft');
    if (!d) return;
    getDraft(d).then(async (dr) => {
      if (!dr || dr.account !== account) return;
      if (dr.dataEpoch !== me?.dataEpoch) {
        setDraftMsg('この下書きは復元前（または別の表示）のデータ世代で作られたため送信できません。内容を見ながら新しく入力してください。');
      } else cmd.setKey(dr.id);
      setDraftId(dr.id);
      const p = dr.payload;
      setDate(p.date);
      setReason(p.reason ?? '');
      setNote(p.note ?? '');
      setPurpose(p.purpose ?? 'sale');
      setRef(p.ref ?? '');
      setDest(p.dest ?? '');
      const fresh = await Promise.all(p.lines.map(async (l: any) => ({ ...l, sku: await loadSku(l.sku.id).catch(() => l.sku) })));
      setLines(fresh);
      setStep('confirm');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp, account]);
  useEffect(() => {
    const s = sp.get('skuId');
    if (s && !sp.get('draft')) loadSku(s).then((sku) => setLines([{ sku, locationId: '', qty: null, direction: 'increase' }]));
  }, [sp]);

  const locList: Loc[] = locs.data ?? [];
  const normalLocs = locList.filter((l) => !c.normalOnly || l.kind === 'normal');
  const addSku = (sku: SkuHit) => {
    if (lines.some((l) => l.sku.id === sku.id && l.locationId === defaultLoc)) return;
    let loc = defaultLoc;
    if (!loc && c.sign <= 0) {
      const best = sku.locations.filter((x) => x.qty > 0 && (!c.normalOnly || x.kind === 'normal')).sort((a, b) => b.qty - a.qty)[0];
      if (best && locList.find((l) => l.id === best.locationId && !l.stocktakeId)) loc = best.locationId;
    }
    setLines([...lines, { sku, locationId: loc, qty: null, direction: 'increase' }]);
  };
  const delta = (l: Line) => (c.sign === 0 ? (l.direction === 'decrease' ? -1 : 1) : c.sign) * (l.qty ?? 0);
  const valid =
    lines.length > 0 &&
    lines.every((l) => l.locationId && l.qty && l.qty > 0) &&
    (c.reason !== 'required' || reason.trim()) &&
    new Set(lines.map((l) => `${l.sku.id}|${l.locationId}`)).size === lines.length;
  const anyNegative = lines.some((l) => qtyAt(l.sku, l.locationId) + delta(l) < 0);

  const body = () => {
    const base: any = { businessDate: date, note, lines: lines.map((l) => ({ skuId: l.sku.id, locationId: l.locationId, qty: l.qty })) };
    if (kind !== 'initial') base.expected = lines.map((l) => ({ skuId: l.sku.id, locationId: l.locationId, qty: qtyAt(l.sku, l.locationId) }));
    if (c.reason !== 'none') base.reason = reason;
    if (c.purpose) base.purpose = purpose;
    if (c.ref) base.externalRef = ref;
    if (c.dest) base.destinationLabel = dest;
    if (kind === 'correction') base.lines = lines.map((l) => ({ skuId: l.sku.id, locationId: l.locationId, qty: l.qty, direction: l.direction }));
    return base;
  };
  const saveAsDraft = async () => {
    const d: DeviceDraft = {
      id: cmd.key(),
      account,
      dataEpoch: me!.dataEpoch,
      kind: kind === 'correction' || kind === 'initial' ? 'issue' : (kind as DeviceDraft['kind']),
      title: `${c.title}：${lines.map((l) => `${l.sku.code}×${l.qty ?? '?'}`).join('、')}`,
      payload: { route: `/${kind === 'issue' ? 'issue' : `more/${kind}`}`, date, reason, note, purpose, ref, dest, lines },
      basis: lines.map((l) => ({ skuId: l.sku.id, locationId: l.locationId, qty: qtyAt(l.sku, l.locationId) })),
      savedAt: new Date().toISOString(),
      status: cmd.state.phase === 'unknown' ? 'unknown' : 'draft',
    };
    const ok = await saveDraft(d);
    setDraftMsg(ok ? '端末に下書きとして保存しました（未送信・在庫は変わっていません）。通信が戻ったら「端末下書き」から内容を確認して送信してください。' : '端末に保存できませんでした（容量不足・プライベートモード等）。');
  };
  const refreshLatest = async () => {
    setRefreshing(true);
    try {
      setLines(await Promise.all(lines.map(async (l) => ({ ...l, sku: await loadSku(l.sku.id) }))));
    } finally {
      setRefreshing(false);
    }
  };
  const confirmSend = async () => {
    const r = await cmd.submit(body());
    if (r && draftId) await removeDraft(draftId);
    if (!r && cmd.state.phase !== 'unknown') {
      /* エラー表示は CmdStatus */
    }
  };

  if (cmd.state.phase === 'done') {
    const res = cmd.state.result;
    return (
      <div>
        <h1>{c.title}</h1>
        <CmdStatus state={cmd.state} onCheck={cmd.check} onResend={cmd.resend} />
        <ResultLines result={res} />
        <div className="btn-row">
          <Link to={`/ops/${res.operationId}`} className="btn">
            伝票を見る（{res.opNo}）
          </Link>
          <button
            className="btn btn-primary"
            onClick={() => {
              cmd.reset();
              setLines([]);
              setStep('input');
              setReason('');
              setNote('');
              setDraftId(null);
              nav(kind === 'issue' ? '/issue' : `/more/${kind}`, { replace: true });
            }}
          >
            続けて{c.title}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1>{c.title}</h1>
      <div className="steps" aria-label="手順">
        <span className={step === 'input' ? 'on' : ''}>1 商品・場所・数量</span>
        <span className={step === 'confirm' ? 'on' : ''}>2 確認して確定</span>
      </div>
      <p className="small muted">{c.help}</p>
      {draftMsg && <p className="msg msg-warn">{draftMsg}</p>}
      {locs.loading && <Loading />}
      {step === 'input' && (
        <>
          {locList.length === 0 && !locs.loading && (
            <p className="msg msg-warn">
              保管場所がありません。<Link to="/locations">保管場所を登録</Link>してください。
            </p>
          )}
          <LocationSelect
            locations={locList}
            value={defaultLoc}
            onChange={(v) => {
              setDefaultLoc(v);
              setLines(lines.map((l) => ({ ...l, locationId: l.locationId || v })));
            }}
            label={c.sign > 0 ? '入庫先（まとめて指定）' : '出庫元の場所（まとめて指定）'}
            filter={(l) => !c.normalOnly || l.kind === 'normal'}
          />
          <SkuPicker onPick={addSku} />
          {lines.map((l, i) => (
            <div key={i} className="card">
              <SkuCard s={l.sku} onClear={() => setLines(lines.filter((_, j) => j !== i))} />
              <LocationSelect
                locations={normalLocs}
                value={l.locationId}
                onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, locationId: v } : x)))}
                label={c.sign > 0 ? '入庫先' : c.sign < 0 ? '出庫元' : '場所'}
                qtyOf={(id) => qtyAt(l.sku, id)}
                unit={l.sku.unit}
              />
              {kind === 'correction' && (
                <div className="chips" role="radiogroup" aria-label="増減">
                  {(['increase', 'decrease'] as const).map((d) => (
                    <button key={d} type="button" className={`chip ${l.direction === d ? 'on' : ''}`} aria-pressed={l.direction === d} onClick={() => setLines(lines.map((x, j) => (j === i ? { ...x, direction: d } : x)))}>
                      {d === 'increase' ? '増やす' : '減らす'}
                    </button>
                  ))}
                </div>
              )}
              <QtyInput label="数量" unit={l.sku.unit} value={l.qty} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: v } : x)))} />
              {l.locationId && l.qty ? <ChangePreview before={qtyAt(l.sku, l.locationId)} delta={delta(l)} unit={l.sku.unit} /> : null}
              {l.locationId && qtyAt(l.sku, l.locationId) + delta(l) < 0 && (
                <p className="msg msg-error">
                  この場所の在庫（{qtyAt(l.sku, l.locationId)}）が足りません。他の場所：
                  {l.sku.locations.filter((x) => x.locationId !== l.locationId && x.qty > 0).map((x) => `${x.name} ${x.qty}`).join('、') || 'なし'}。自動で他の場所からは減らしません。
                </p>
              )}
            </div>
          ))}
          {c.purpose && (
            <Field label="目的">
              <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                {PURPOSES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {c.reason !== 'none' && (
            <Field label={`理由${c.reason === 'required' ? '（必須）' : ''}`}>
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            </Field>
          )}
          {c.dest && (
            <Field label="行先ラベル（任意）" hint="例：週末クラフト市、店舗名。貸出期限・返却の管理はしません。">
              <input value={dest} onChange={(e) => setDest(e.target.value)} maxLength={100} />
            </Field>
          )}
          {c.ref && (
            <Field label="外部伝票番号・参照番号（任意）">
              <input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={100} />
            </Field>
          )}
          <BusinessDate value={date} onChange={setDate} />
          <Field label="メモ（任意）">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </Field>
          <div className="sticky-actions">
            <button className="btn btn-primary btn-block" disabled={!valid || anyNegative} onClick={() => setStep('confirm')}>
              確認へ進む
            </button>
          </div>
        </>
      )}
      {step === 'confirm' && (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>内容の確認</h2>
            {lines.map((l, i) => {
              const loc = locList.find((x) => x.id === l.locationId);
              return (
                <div key={i} style={{ borderBottom: '1px solid var(--line)', paddingBottom: '0.5rem', marginBottom: '0.5rem' }}>
                  <div>
                    <strong>{l.sku.code}</strong> {l.sku.name} {variant(l.sku.color, l.sku.size) && <span className="badge">{variant(l.sku.color, l.sku.size)}</span>}
                  </div>
                  <div className="small">
                    場所：{loc?.name}
                    {loc?.kind === 'hold' && '（保留）'}
                  </div>
                  <ChangePreview before={qtyAt(l.sku, l.locationId)} delta={delta(l)} unit={l.sku.unit} />
                </div>
              );
            })}
            <dl className="kv small">
              {c.purpose && (
                <>
                  <dt>目的</dt>
                  <dd>{PURPOSES.find((p) => p[0] === purpose)?.[1]}</dd>
                </>
              )}
              {reason && (
                <>
                  <dt>理由</dt>
                  <dd>{reason}</dd>
                </>
              )}
              <dt>業務日付</dt>
              <dd>{date}</dd>
            </dl>
            <p className="small muted">
              表示数量の取得：{lastServerContact() ? fmtDateTime(new Date(lastServerContact()).toISOString()) : '—'}。確定時にサーバーで最新数量を再検査します。
            </p>
            <button className="btn btn-small" onClick={refreshLatest} disabled={refreshing || !online}>
              最新の数量を読み直す
            </button>
          </div>
          <CmdStatus
            state={cmd.state}
            onCheck={async () => {
              const r = await cmd.check();
              if (r === 'not_found') setDraftMsg('サーバーには届いていませんでした。内容を確認して、もう一度「確定する」を押してください（同じ操作キーで送るため二重登録になりません）。');
            }}
            onResend={cmd.resend}
          />
          {cmd.state.phase === 'error' && cmd.state.error.code === 'STALE_QTY' && (
            <button className="btn" onClick={refreshLatest}>
              最新の数量で確認し直す
            </button>
          )}
          <div className="sticky-actions">
            {!online ? (
              <>
                <p className="msg msg-warn small">オフラインのため確定できません。端末に下書きとして残せます（在庫は変わりません）。</p>
                <button className="btn btn-block" onClick={saveAsDraft}>
                  端末に下書き保存
                </button>
              </>
            ) : (
              <div className="btn-row">
                <button className="btn" onClick={() => setStep('input')} disabled={cmd.state.phase === 'sending' || cmd.state.phase === 'unknown'}>
                  戻って修正
                </button>
                <button
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  disabled={cmd.state.phase === 'sending' || cmd.state.phase === 'unknown' || cmd.state.phase === 'checking' || !!(draftMsg && draftMsg.includes('データ世代'))}
                  onClick={confirmSend}
                >
                  {c.title}を確定する
                </button>
                {cmd.state.phase === 'unknown' && (
                  <button className="btn" onClick={saveAsDraft}>
                    下書きに残す
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function ResultLines({ result }: { result: any }) {
  if (!result?.lines) return null;
  return (
    <div className="card">
      <div>
        伝票番号 <strong>{result.opNo}</strong>（{result.businessDate}）
      </div>
      {result.lines.map((l: any) => (
        <div key={l.lineNo} className="small" style={{ marginTop: '0.3rem' }}>
          {l.skuCode} {l.skuName}／{l.locationName}：{l.before} → <strong>{l.after}</strong> {l.unit}（{l.delta > 0 ? `+${l.delta}` : l.delta}）
        </div>
      ))}
      <p className="small muted">PC など他の端末でも、画面の再読み込み・復帰時に反映されます。</p>
    </div>
  );
}

// ---------- 場所移動 ----------
export function TransferPage() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { me, online, account } = useApp();
  const locs = useLocations();
  const cmd = useCommand('/api/ops/transfer');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [lines, setLines] = useState<{ sku: SkuHit; qty: number | null }[]>([]);
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayTokyo());
  const [step, setStep] = useState<'input' | 'confirm'>('input');
  const [msg, setMsg] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const locList = locs.data ?? [];
  const fromLoc = locList.find((l) => l.id === from);
  const toLoc = locList.find((l) => l.id === to);
  const needsReason = fromLoc?.kind === 'hold' && toLoc?.kind === 'normal';
  useEffect(() => {
    const s = sp.get('skuId');
    if (s && !sp.get('draft')) loadSku(s).then((sku) => setLines([{ sku, qty: null }]));
    const d = sp.get('draft');
    if (d)
      getDraft(d).then(async (dr) => {
        if (!dr || dr.account !== account) return;
        if (dr.dataEpoch !== me?.dataEpoch) setMsg('この下書きは別のデータ世代で作られたため送信できません。');
        else cmd.setKey(dr.id);
        setDraftId(dr.id);
        setFrom(dr.payload.from);
        setTo(dr.payload.to);
        setReason(dr.payload.reason);
        setDate(dr.payload.date);
        setLines(await Promise.all(dr.payload.lines.map(async (l: any) => ({ ...l, sku: await loadSku(l.sku.id).catch(() => l.sku) }))));
        setStep('confirm');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp, account]);
  const valid = from && to && from !== to && lines.length > 0 && lines.every((l) => l.qty && l.qty > 0 && l.qty <= qtyAt(l.sku, from)) && (!needsReason || reason.trim());
  const body = () => ({
    businessDate: date,
    fromLocationId: from,
    toLocationId: to,
    reason,
    note: '',
    lines: lines.map((l) => ({ skuId: l.sku.id, qty: l.qty })),
    expected: lines.flatMap((l) => [
      { skuId: l.sku.id, locationId: from, qty: qtyAt(l.sku, from) },
      { skuId: l.sku.id, locationId: to, qty: qtyAt(l.sku, to) },
    ]),
  });
  if (cmd.state.phase === 'done') {
    return (
      <div>
        <h1>場所移動</h1>
        <CmdStatus state={cmd.state} onCheck={cmd.check} onResend={cmd.resend} />
        <ResultLines result={cmd.state.result} />
        <div className="btn-row">
          <Link className="btn" to={`/ops/${cmd.state.result.operationId}`}>
            伝票を見る
          </Link>
          <button
            className="btn btn-primary"
            onClick={() => {
              cmd.reset();
              setLines([]);
              setStep('input');
              setReason('');
              nav('/transfer', { replace: true });
            }}
          >
            続けて移動
          </button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <h1>場所移動</h1>
      <div className="steps">
        <span className={step === 'input' ? 'on' : ''}>1 移動元・移動先・商品・数量</span>
        <span className={step === 'confirm' ? 'on' : ''}>2 確認して確定</span>
      </div>
      <p className="small muted">現物を移動し終えたことを記録します。全体の数量は変わりません。保留→通常の移動は検品解除として理由を残します。</p>
      {msg && <p className="msg msg-warn">{msg}</p>}
      {step === 'input' && (
        <>
          <LocationSelect locations={locList} value={from} onChange={setFrom} label="移動元" />
          <LocationSelect locations={locList} value={to} onChange={setTo} label="移動先" filter={(l) => l.id !== from} />
          {from && <SkuPicker onPick={(s) => !lines.some((l) => l.sku.id === s.id) && setLines([...lines, { sku: s, qty: null }])} />}
          {lines.map((l, i) => (
            <div className="card" key={l.sku.id}>
              <SkuCard s={l.sku} onClear={() => setLines(lines.filter((_, j) => j !== i))} />
              <QtyInput label="移動する数量" unit={l.sku.unit} value={l.qty} max={Math.max(1, qtyAt(l.sku, from))} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: v } : x)))} />
              {from && qtyAt(l.sku, from) === 0 && <p className="msg msg-error">移動元に在庫がありません</p>}
              {from && to && l.qty ? (
                <>
                  <ChangePreview label={`移動元 ${fromLoc?.name}`} before={qtyAt(l.sku, from)} delta={-l.qty} unit={l.sku.unit} />
                  <ChangePreview label={`移動先 ${toLoc?.name}`} before={qtyAt(l.sku, to)} delta={l.qty} unit={l.sku.unit} />
                </>
              ) : null}
            </div>
          ))}
          {fromLoc?.kind === 'normal' && toLoc?.kind === 'hold' && <p className="msg msg-info small">通常→保留：全体数量は変わりませんが、利用可能数量は減ります。</p>}
          <Field label={`理由${needsReason ? '（検品解除のため必須）' : '（任意）'}`}>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
          <BusinessDate value={date} onChange={setDate} />
          <div className="sticky-actions">
            <button className="btn btn-primary btn-block" disabled={!valid} onClick={() => setStep('confirm')}>
              確認へ進む
            </button>
          </div>
        </>
      )}
      {step === 'confirm' && (
        <>
          <div className="card">
            <div>
              <strong>{fromLoc?.name}</strong> → <strong>{toLoc?.name}</strong>
            </div>
            {lines.map((l) => (
              <div key={l.sku.id}>
                <div style={{ marginTop: '0.5rem' }}>
                  <strong>{l.sku.code}</strong> {l.sku.name} {variant(l.sku.color, l.sku.size)}
                </div>
                <ChangePreview label={`移動元 ${fromLoc?.name}`} before={qtyAt(l.sku, from)} delta={-(l.qty ?? 0)} unit={l.sku.unit} />
                <ChangePreview label={`移動先 ${toLoc?.name}`} before={qtyAt(l.sku, to)} delta={l.qty ?? 0} unit={l.sku.unit} />
              </div>
            ))}
          </div>
          <CmdStatus state={cmd.state} onCheck={cmd.check} onResend={cmd.resend} />
          <div className="sticky-actions">
            {!online ? (
              <button
                className="btn btn-block"
                onClick={async () => {
                  const ok = await saveDraft({
                    id: cmd.key(),
                    account,
                    dataEpoch: me!.dataEpoch,
                    kind: 'transfer',
                    title: `移動：${fromLoc?.name}→${toLoc?.name} ${lines.map((l) => `${l.sku.code}×${l.qty}`).join('、')}`,
                    payload: { route: '/transfer', from, to, reason, date, lines },
                    basis: lines.map((l) => ({ skuId: l.sku.id, locationId: from, qty: qtyAt(l.sku, from) })),
                    savedAt: new Date().toISOString(),
                    status: 'draft',
                  });
                  setMsg(ok ? '端末に下書きとして保存しました（未送信）。' : '端末に保存できませんでした。');
                }}
              >
                オフライン：端末に下書き保存
              </button>
            ) : (
              <div className="btn-row">
                <button className="btn" onClick={() => setStep('input')} disabled={cmd.state.phase === 'sending' || cmd.state.phase === 'unknown'}>
                  戻って修正
                </button>
                <button
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  disabled={['sending', 'unknown', 'checking'].includes(cmd.state.phase) || !!msg?.includes('データ世代')}
                  onClick={async () => {
                    const r = await cmd.submit(body());
                    if (r && draftId) await removeDraft(draftId);
                  }}
                >
                  移動を確定する
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- 伝票詳細 ----------
export function OpDetail() {
  const { id } = useParams();
  const [op, setOp] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    get(`/api/ops/${id}`).then(setOp, setErr);
  }, [id]);
  if (err) return <ErrorMsg error={err} />;
  if (!op) return <Loading />;
  return (
    <div>
      <h1>伝票 {op.opNo}</h1>
      <div className="card small">
        <dl className="kv">
          <dt>業務日付</dt>
          <dd>{op.businessDate}</dd>
          <dt>確定日時</dt>
          <dd>{fmtDateTime(op.committedAt)}</dd>
          {op.poNo && (
            <>
              <dt>発注</dt>
              <dd>
                <Link to={`/pos/${op.poId}`}>{op.poNo}</Link>
              </dd>
            </>
          )}
          {op.stNo && (
            <>
              <dt>棚卸</dt>
              <dd>
                <Link to={`/stocktakes/${op.stocktakeId}`}>{op.stNo}</Link>
              </dd>
            </>
          )}
          {op.reason && (
            <>
              <dt>理由</dt>
              <dd>{op.reason}</dd>
            </>
          )}
          {op.externalRef && (
            <>
              <dt>参照番号</dt>
              <dd>{op.externalRef}</dd>
            </>
          )}
          {op.destinationLabel && (
            <>
              <dt>行先</dt>
              <dd>{op.destinationLabel}</dd>
            </>
          )}
          {op.note && (
            <>
              <dt>メモ</dt>
              <dd>{op.note}</dd>
            </>
          )}
        </dl>
      </div>
      <ReversibleHistory rows={op.lines} />
    </div>
  );
}

/** 履歴一覧＋取消（誤登録の取消は補償イベント。実際の返品とは別操作） */
export function ReversibleHistory({ rows, onChanged }: { rows: any[]; onChanged?: () => void }) {
  const [target, setTarget] = useState<any>(null);
  return (
    <>
      <HistoryTable rows={rows} onReverse={setTarget} />
      {target && <ReversalSheet ev={target} onClose={() => setTarget(null)} onDone={() => (setTarget(null), onChanged?.())} />}
    </>
  );
}

function ReversalSheet({ ev, onClose, onDone }: { ev: any; onClose: () => void; onDone: () => void }) {
  const cmd = useCommand('/api/ops/reversal');
  const max = Math.abs(ev.qty) - ev.reversed;
  const [qty, setQty] = useState<number | null>(max);
  const [reason, setReason] = useState('');
  const isTransfer = ev.kind === 'transfer_out' || ev.kind === 'transfer_in';
  return (
    <Sheet title="誤登録の取消" onClose={onClose}>
      <p className="small">
        {ev.opNo}：{ev.kindLabel} {ev.sku.code} {ev.location.name} {ev.qty > 0 ? `+${ev.qty}` : ev.qty}
      </p>
      <p className="msg msg-info small">
        入力の誤りを取り消します。元の記録は残り、反対方向の記録（補償）が追加されます。実際に商品が戻った・返送した場合は「顧客返品」「仕入先返品」を使ってください。
        {isTransfer && ' 移動は移動元・移動先の両方を同時に戻します。'}
        {ev.kind === 'po_receipt' && ' 発注の受領数も同じ数量だけ戻ります。'}
      </p>
      <QtyInput label="取り消す数量" unit={ev.sku.unit} value={qty} max={max} onChange={setQty} />
      <Field label="理由（必須）">
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </Field>
      <CmdStatus state={cmd.state} onCheck={cmd.check} onResend={cmd.resend} />
      {cmd.state.phase === 'done' ? (
        <button className="btn btn-primary btn-block" onClick={onDone}>
          閉じる
        </button>
      ) : (
        <button
          className="btn btn-danger btn-block"
          disabled={!qty || !reason.trim() || ['sending', 'unknown', 'checking'].includes(cmd.state.phase)}
          onClick={() => cmd.submit({ eventId: ev.id, qty, reason, businessDate: todayTokyo(), note: '' })}
        >
          取消を確定する
        </button>
      )}
    </Sheet>
  );
}

export function HistoryPage() {
  const [sp] = useSearchParams();
  const [before, setBefore] = useState<number[]>([]);
  const cursor = before[before.length - 1];
  const [kind, setKind] = useState('');
  const url = `/api/history${qs({ skuId: sp.get('skuId'), locationId: sp.get('locationId'), kind, limit: 50, beforeSeq: cursor })}`;
  const { data, error, loading, reload } = useFetch<any>(url);
  return (
    <div>
      <h1>入出庫履歴</h1>
      <p className="small muted">確定した順（新しい順）。取消は「取消」ボタンから。</p>
      <Field label="種別">
        <select value={kind} onChange={(e) => (setKind(e.target.value), setBefore([]))}>
          <option value="">すべて</option>
          {Object.entries({
            initial: '初期在庫',
            po_receipt: '発注入荷',
            outside_receipt: '発注外入庫',
            issue_sale: '販売目的出庫',
            issue_other: 'その他出庫',
            customer_return: '顧客返品入庫',
            supplier_return: '仕入先返品出庫',
            transfer_out: '移動（出）',
            transfer_in: '移動（入）',
            disposal: '破損・廃棄',
            stocktake_adjust: '棚卸調整',
            correction: '数量訂正',
            reversal: '取消',
          }).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      {loading && <Loading />}
      <ErrorMsg error={error} />
      {data && <ReversibleHistory rows={data.rows} onChanged={reload} />}
      <div className="btn-row">
        <button className="btn" disabled={!before.length} onClick={() => setBefore(before.slice(0, -1))}>
          新しい方へ
        </button>
        <button className="btn" disabled={!data?.nextBeforeSeq} onClick={() => setBefore([...before, data.nextBeforeSeq])}>
          古い方へ
        </button>
      </div>
    </div>
  );
}
