import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, del, post, put } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Empty, ErrorMsg, Field, KindBadge, Loading, Photo, Sheet, useFetch, variant } from '../components/ui';

export function Locations() {
  const [all, setAll] = useState(false);
  const { me } = useApp();
  const { data, error, loading, reload } = useFetch<any[]>(`/api/locations${all ? '?all=1' : ''}`, [me?.dataEpoch]);
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <div>
      <div className="row" style={{ alignItems: 'center' }}>
        <h1 style={{ flex: 1 }}>保管場所</h1>
        <button className="btn btn-small" style={{ flex: '0 0 auto' }} onClick={() => setEdit({ code: '', name: '', description: '', kind: 'normal' })}>
          ＋ 場所を追加
        </button>
      </div>
      <p className="small muted">
        「通常」は出庫・補充計算の利用可能数量に含めます。「保留」は現物はあるが良品として出庫しない場所（破損・返品直後・検品待ち）です。在庫がある場所の種類は変更できません（別の場所を作って移動してください）。
      </p>
      <label className="check small">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> アーカイブ済みも表示
      </label>
      {loading && <Loading />}
      <ErrorMsg error={error} />
      {data?.length === 0 && <Empty>場所がありません。棚・箱・イベントケース・検品保留箱などを登録してください。</Empty>}
      <div className="cards">
        {data?.map((l) => (
          <div key={l.id} className="item">
            <div style={{ flex: 1 }}>
              <Link to={`/locations/${l.id}`}>
                <strong>{l.name}</strong>
              </Link>{' '}
              <span className="muted small">{l.code}</span> <KindBadge kind={l.kind} /> {l.stocktakeId && <span className="badge badge-warn">棚卸中 {l.stNo}</span>}
              {l.archived && <span className="badge">アーカイブ</span>}
              <div className="small muted">
                {l.description} ／ 在庫のあるSKU {l.skuCount}
              </div>
            </div>
            <button className="btn btn-small" style={{ flex: '0 0 auto' }} onClick={() => setEdit(l)}>
              編集
            </button>
          </div>
        ))}
      </div>
      {edit && <LocationForm loc={edit} onClose={() => setEdit(null)} onDone={() => (setEdit(null), reload())} />}
    </div>
  );
}

function LocationForm({ loc, onClose, onDone }: { loc: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ code: loc.code, name: loc.name, description: loc.description, kind: loc.kind });
  const [err, setErr] = useState<unknown>(null);
  return (
    <Sheet title={loc.id ? '場所を編集' : '場所を追加'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try {
            if (loc.id) await put(`/api/locations/${loc.id}`, { ...f, version: loc.version });
            else await post('/api/locations', f);
            onDone();
          } catch (e2) {
            setErr(e2);
          }
        }}
      >
        <Field label="場所コード（一意）">
          <input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} maxLength={40} required />
        </Field>
        <Field label="名称">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={100} required />
        </Field>
        <Field label="種類">
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="normal">通常（利用可能に含む）</option>
            <option value="hold">保留（利用可能に含めない）</option>
          </select>
        </Field>
        <Field label="説明">
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={500} />
        </Field>
        <ErrorMsg error={err} />
        <button className="btn btn-primary btn-block">保存</button>
        {loc.id && (
          <div className="btn-row">
            <button
              type="button"
              className="btn"
              onClick={async () => {
                try {
                  await post(`/api/locations/${loc.id}/archive`, { archived: !loc.archived });
                  onDone();
                } catch (e) {
                  setErr(e);
                }
              }}
            >
              {loc.archived ? 'アーカイブ解除' : 'アーカイブ'}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                if (!confirm('参照のない場所だけ削除できます。削除しますか？')) return;
                try {
                  await del(`/api/locations/${loc.id}`);
                  onDone();
                } catch (e) {
                  setErr(e);
                }
              }}
            >
              削除
            </button>
          </div>
        )}
      </form>
    </Sheet>
  );
}

export function LocationDetail() {
  const { id } = useParams();
  const locs = useFetch<any[]>('/api/locations?all=1');
  const stock = useFetch<any[]>(`/api/locations/${id}/stock`);
  const nav = useNavigate();
  const l = locs.data?.find((x) => x.id === id);
  return (
    <div>
      <h1>
        {l?.name ?? '場所'} {l && <KindBadge kind={l.kind} />}
      </h1>
      {l?.stocktakeId && (
        <p className="msg msg-warn">
          棚卸中（<Link to={`/stocktakes/${l.stocktakeId}`}>{l.stNo}</Link>）のため入出庫停止中です。
        </p>
      )}
      <div className="btn-row">
        <Link className="btn" to={`/labels`}>
          場所QRラベル
        </Link>
        <Link className="btn" to={`/history?locationId=${id}`}>
          この場所の履歴
        </Link>
      </div>
      {stock.loading && <Loading />}
      <ErrorMsg error={stock.error} />
      {stock.data?.length === 0 && <Empty>この場所に在庫はありません</Empty>}
      <div className="cards">
        {stock.data?.map((s) => (
          <button key={s.skuId} className="item" style={{ width: '100%', textAlign: 'left', font: 'inherit', cursor: 'pointer' }} onClick={() => nav(`/skus/${s.skuId}`)}>
            <Photo fileId={s.photoFileId} alt={s.name} />
            <div>
              <strong>{s.code}</strong> {s.name} <span className="small muted">{variant(s.color, s.size)}</span>
              <div className="qtybig" style={{ fontSize: '1.2rem' }}>
                {s.qty} <small>{s.unit}</small>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Suppliers() {
  const { me } = useApp();
  const [all, setAll] = useState(false);
  const { data, error, loading, reload } = useFetch<any[]>(`/api/suppliers${all ? '?all=1' : ''}`, [me?.dataEpoch]);
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <div>
      <div className="row" style={{ alignItems: 'center' }}>
        <h1 style={{ flex: 1 }}>仕入先</h1>
        <button className="btn btn-small" style={{ flex: '0 0 auto' }} onClick={() => setEdit({ code: '', name: '', contactName: '', contact: '', leadTimeDays: null, note: '' })}>
          ＋ 仕入先を追加
        </button>
      </div>
      <p className="small muted">連絡先は発注書の宛名用です。アプリから自動でメール送信・自動発注はしません。</p>
      <label className="check small">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> アーカイブ済みも表示
      </label>
      {loading && <Loading />}
      <ErrorMsg error={error} />
      {data?.length === 0 && <Empty>仕入先はまだありません</Empty>}
      <div className="cards">
        {data?.map((s) => (
          <div key={s.id} className="item">
            <div style={{ flex: 1 }}>
              <strong>{s.name}</strong> <span className="small muted">{s.code}</span> {s.archived && <span className="badge">アーカイブ</span>}
              <div className="small muted">
                {s.contactName} {s.leadTimeDays !== null && `／ リードタイム ${s.leadTimeDays}日`}
              </div>
            </div>
            <button className="btn btn-small" style={{ flex: '0 0 auto' }} onClick={() => setEdit(s)}>
              編集
            </button>
          </div>
        ))}
      </div>
      {edit && <SupplierForm s={edit} onClose={() => setEdit(null)} onDone={() => (setEdit(null), reload())} />}
    </div>
  );
}

function SupplierForm({ s, onClose, onDone }: { s: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ code: s.code, name: s.name, contactName: s.contactName, contact: s.contact, leadTimeDays: s.leadTimeDays === null ? '' : String(s.leadTimeDays), note: s.note });
  const [err, setErr] = useState<unknown>(null);
  return (
    <Sheet title={s.id ? '仕入先を編集' : '仕入先を追加'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          const body = { ...f, leadTimeDays: f.leadTimeDays === '' ? null : Number(f.leadTimeDays) };
          try {
            if (s.id) await put(`/api/suppliers/${s.id}`, { ...body, version: s.version });
            else await post('/api/suppliers', body);
            onDone();
          } catch (e2) {
            setErr(e2 instanceof ApiError ? e2 : e2);
          }
        }}
      >
        <Field label="仕入先コード">
          <input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} maxLength={40} required />
        </Field>
        <Field label="名称">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={100} required />
        </Field>
        <Field label="担当者（任意）">
          <input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} maxLength={100} />
        </Field>
        <Field label="連絡先（任意・発注書には出しません）">
          <input value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} maxLength={300} />
        </Field>
        <Field label="標準リードタイム（日）">
          <input inputMode="numeric" value={f.leadTimeDays} onChange={(e) => setF({ ...f, leadTimeDays: e.target.value.replace(/\D/g, '') })} />
        </Field>
        <Field label="備考">
          <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={2000} />
        </Field>
        <ErrorMsg error={err} />
        <button className="btn btn-primary btn-block">保存</button>
        {s.id && (
          <button
            type="button"
            className="btn"
            style={{ marginTop: '0.5rem' }}
            onClick={async () => {
              try {
                await post(`/api/suppliers/${s.id}/archive`, { archived: !s.archived });
                onDone();
              } catch (e) {
                setErr(e);
              }
            }}
          >
            {s.archived ? 'アーカイブ解除' : 'アーカイブ'}
          </button>
        )}
      </form>
    </Sheet>
  );
}
