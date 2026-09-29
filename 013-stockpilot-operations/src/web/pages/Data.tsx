import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, get, post } from '../lib/api';
import { useApp } from '../lib/app-context';
import { useCommand } from '../lib/useCommand';
import { listDrafts, removeDraft, removeAllDrafts, type DeviceDraft } from '../lib/drafts';
import { CmdStatus, Empty, ErrorMsg, Field, Loading, todayTokyo, useFetch, fmtDateTime } from '../components/ui';

const KINDS: [string, string, string][] = [
  ['skus', '商品マスター', '最大5,000行。既存SKUは上書きしません（在庫数列は取り込みません）'],
  ['locations', '保管場所', '種類は「通常」または「保留」'],
  ['suppliers', '仕入先', ''],
  ['initial_stock', '初期在庫', '履歴のないSKU×場所だけ。最大2,000行'],
  ['po_drafts', '発注下書き', '仕入先（と発注グループ）ごとに下書きを作成'],
  ['movements', '入出庫履歴の一括登録', '通常の確定と同じ検証。最大2,000行'],
];

export function CsvPage() {
  const [kind, setKind] = useState('skus');
  const [encoding, setEncoding] = useState('utf-8');
  const [file, setFile] = useState<File | null>(null);
  const [pv, setPv] = useState<any>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [date, setDate] = useState(todayTokyo());
  const cmd = useCommand(pv ? `/api/import/${pv.importId}/commit` : '/api/import/none/commit');
  const preview = async (map?: Record<string, number>) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    const fd = new FormData();
    fd.append('kind', kind);
    fd.append('encoding', encoding);
    if (map) fd.append('mapping', JSON.stringify(map));
    fd.append('file', file);
    try {
      const r = await api('POST', '/api/import/preview', fd);
      setPv(r);
      setMapping(r.mapping);
      setExcluded(new Set());
      cmd.reset();
    } catch (e) {
      setErr(e);
      setPv(null);
    } finally {
      setBusy(false);
    }
  };
  const errorRows = (pv?.rows ?? []).filter((r: any) => r.errors.length);
  const unresolved = errorRows.filter((r: any) => !excluded.has(r.rowNo));
  return (
    <div>
      <h1>CSV取込・出力</h1>
      <h2>取込</h2>
      <div className="card">
        <ol className="small">
          <li>ファイル選択 → 文字コード・列の割当</li>
          <li>プレビュー（この段階では在庫・マスターは変わりません）</li>
          <li>エラー行を修正するか、明示的に除外</li>
          <li>件数・SKU・場所ごとの増減を確認して確定（全行まとめて反映、失敗時は全体を戻します）</li>
        </ol>
        <Field label="取込の種類">
          <select value={kind} onChange={(e) => (setKind(e.target.value), setPv(null))}>
            {KINDS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <p className="small muted">
          {KINDS.find((k) => k[0] === kind)?.[2]} <a href={`/api/import/templates/${kind}`}>テンプレートをダウンロード</a>
        </p>
        <Field label="文字コード">
          <select value={encoding} onChange={(e) => setEncoding(e.target.value)}>
            <option value="utf-8">UTF-8（BOMあり・なし）</option>
            <option value="shift_jis">Shift_JIS（Excelの古い形式）</option>
          </select>
        </Field>
        <Field label="CSVファイル（5MBまで）">
          <input type="file" accept=".csv,text/csv" onChange={(e) => (setFile(e.target.files?.[0] ?? null), setPv(null))} />
        </Field>
        <button className="btn btn-primary" disabled={!file || busy} onClick={() => preview()}>
          {busy ? '読み込み中…' : 'プレビュー'}
        </button>
        <ErrorMsg error={err} />
      </div>
      {pv && (
        <div className="card">
          <h3>列の割当</h3>
          <div className="row">
            {pv.fields.map((f: any) => (
              <Field key={f.key} label={`${f.label}${f.required ? '（必須）' : ''}`}>
                <select value={mapping[f.key] ?? ''} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value === '' ? (undefined as any) : Number(e.target.value) })}>
                  <option value="">（使わない）</option>
                  {pv.header.map((h: string, i: number) => (
                    <option key={i} value={i}>
                      {i + 1}列目：{h}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
          <button
            className="btn"
            onClick={() =>
              preview(Object.fromEntries(Object.entries(mapping).filter(([, v]) => v !== undefined && v !== null && !Number.isNaN(v as number))) as Record<string, number>)
            }
          >
            この割当で再プレビュー
          </button>
          {pv.warnings.map((w: string) => (
            <p key={w} className="msg msg-warn small">
              {w}
            </p>
          ))}
          <p>
            全{pv.rowCount}行 ／ エラー {pv.errorCount}行 ／ 除外 {excluded.size}行
          </p>
          {errorRows.length > 0 && (
            <>
              <h3>エラーのある行</h3>
              <button className="btn btn-small" onClick={() => setExcluded(new Set(errorRows.map((r: any) => r.rowNo)))}>
                エラー行をすべて除外する
              </button>
              <div className="table-wrap" style={{ marginTop: 6 }}>
                <table className="list">
                  <thead>
                    <tr>
                      <th>除外</th>
                      <th>行</th>
                      <th>内容</th>
                    </tr>
                  </thead>
                  <tbody>
                    {errorRows.slice(0, 200).map((r: any) => (
                      <tr key={r.rowNo}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`${r.rowNo}行目を除外`}
                            checked={excluded.has(r.rowNo)}
                            onChange={(e) => {
                              const n = new Set(excluded);
                              if (e.target.checked) n.add(r.rowNo);
                              else n.delete(r.rowNo);
                              setExcluded(n);
                            }}
                          />
                        </td>
                        <td>{r.rowNo}</td>
                        <td className="small minus">{r.errors.join(' ／ ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {pv.deltas?.length > 0 && (
            <>
              <h3>SKU・場所ごとの増減</h3>
              <div className="table-wrap">
                <table className="list">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>場所</th>
                      <th className="num">増減</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pv.deltas.slice(0, 300).map((d: any, i: number) => (
                      <tr key={i}>
                        <td>{d.sku}</td>
                        <td>{d.location}</td>
                        <td className={`num ${d.delta >= 0 ? 'plus' : 'minus'}`}>{d.delta > 0 ? `+${d.delta}` : d.delta}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {(kind === 'initial_stock' || kind === 'movements') && (
            <Field label="初期在庫の業務日付（入出庫は各行の日付）">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          )}
          <CmdStatus state={cmd.state} onCheck={cmd.check} onResend={cmd.resend} doneText={cmd.state.phase === 'done' ? `取込 ${cmd.state.result.imported}行、同一内容のためスキップ ${cmd.state.result.skippedSame}行、除外 ${cmd.state.result.excluded}行` : undefined} />
          {cmd.state.phase === 'error' && cmd.state.error.code === 'IMPORT_DUPLICATE' && <p className="small">前回の結果：{JSON.stringify(cmd.state.error.details?.result ?? {})}</p>}
          {cmd.state.phase !== 'done' && (
            <button
              className="btn btn-primary btn-block"
              disabled={unresolved.length > 0 || ['sending', 'unknown', 'checking'].includes(cmd.state.phase)}
              onClick={() => cmd.submit({ excludedRows: [...excluded], businessDate: date })}
            >
              {unresolved.length > 0 ? `未解決のエラー行が${unresolved.length}件あります` : `${pv.rowCount - excluded.size}行を確定する`}
            </button>
          )}
        </div>
      )}
      <h2>出力（UTF-8 BOM付きCSV）</h2>
      <ExportLinks />
    </div>
  );
}

function ExportLinks() {
  const [from, setFrom] = useState(todayTokyo().slice(0, 8) + '01');
  const [to, setTo] = useState(todayTokyo());
  return (
    <div className="card">
      <div className="btn-row">
        <a className="btn" href="/api/export/skus">
          商品一覧
        </a>
        <a className="btn" href="/api/export/stock">
          場所別在庫
        </a>
        <a className="btn" href="/api/export/pos">
          発注一覧・残数
        </a>
        <a className="btn" href="/api/export/replenish">
          補充候補
        </a>
      </div>
      <div className="row">
        <Field label="期間（開始）">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="期間（終了）">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <div className="btn-row">
        <a className="btn" href={`/api/export/history?from=${from}&to=${to}`}>
          入出庫履歴
        </a>
        <a className="btn" href={`/api/export/transfers?from=${from}&to=${to}`}>
          移動履歴
        </a>
      </div>
      <p className="small muted">棚卸差異は各棚卸の画面から出力できます。Excelで開くと先頭の0が消えることがあります。その場合は「データ→テキストから」で文字列として読み込んでください。</p>
    </div>
  );
}

export function BackupPage() {
  const { me, refresh } = useApp();
  const status = useFetch<any>('/api/backup/status', [me?.dataEpoch]);
  const verify = useFetch<any>('/api/verify', [me?.dataEpoch]);
  const [file, setFile] = useState<File | null>(null);
  const [pv, setPv] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  return (
    <div>
      <h1>バックアップ・復元</h1>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>全データの書き出し</h2>
        <p className="small">
          商品・場所・仕入先・発注・受領・出庫・台帳・棚卸・履歴・設定・商品写真を1つのZIPファイルにまとめます（CSV出力は一覧用で、完全なバックアップではありません）。
        </p>
        <p className="small">最後に成功したバックアップ：{status.data?.lastBackupAt ? fmtDateTime(status.data.lastBackupAt) : 'まだありません'}</p>
        <a className="btn btn-primary" href="/api/backup/export" onClick={() => setTimeout(() => status.reload(), 3000)}>
          ZIPをダウンロード
        </a>
        <p className="small muted">ダウンロードが途中で失敗した場合は、成功日時が更新されているか確認し、もう一度実行してください。</p>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>整合性の確認</h2>
        {verify.loading ? (
          <Loading />
        ) : verify.data?.ok ? (
          <p className="msg msg-ok small">台帳の合計と残高、発注の受領数はすべて一致しています。</p>
        ) : verify.data ? (
          <p className="msg msg-error small">不一致があります（{verify.data.balanceMismatches.length + verify.data.poMismatches.length}件）。サポートに連絡してください。</p>
        ) : null}
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>復元（全体の置き換え）</h2>
        <p className="small">
          バックアップZIPの内容で、<strong>現在の本番データ全体を置き換えます</strong>（差分の統合はしません）。現在のデータは退避され、直後なら「元に戻す」で戻せます。復元後は他の端末の画面・未送信の下書きは送信できなくなります。
        </p>
        {me?.mode === 'sample' && <p className="msg msg-warn small">サンプル表示中は復元できません。</p>}
        <Field label="バックアップZIP">
          <input type="file" accept=".zip,application/zip" onChange={(e) => (setFile(e.target.files?.[0] ?? null), setPv(null))} />
        </Field>
        <button
          className="btn"
          disabled={!file || busy || me?.mode === 'sample'}
          onClick={async () => {
            setErr(null);
            setBusy(true);
            const fd = new FormData();
            fd.append('file', file!);
            try {
              setPv(await api('POST', '/api/backup/restore/preview', fd, { timeoutMs: 300_000 }));
            } catch (e) {
              setErr(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '検証中…' : '内容を検証する（まだ置き換えません）'}
        </button>
        <ErrorMsg error={err} />
        {pv && (
          <div className="msg msg-warn">
            <div>
              バックアップ作成：{fmtDateTime(pv.manifest.createdAt)}（{pv.manifest.tenantName}、アプリ {pv.manifest.appVersion}）
            </div>
            <table className="list small" style={{ marginTop: 6 }}>
              <thead>
                <tr>
                  <th>項目</th>
                  <th className="num">現在</th>
                  <th className="num">復元後</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['skus', '商品'],
                  ['locations', '場所'],
                  ['suppliers', '仕入先'],
                  ['purchase_orders', '発注'],
                  ['ledger_events', '台帳'],
                  ['stocktakes', '棚卸'],
                  ['files', '写真'],
                ].map(([k, l]) => (
                  <tr key={k}>
                    <td>{l}</td>
                    <td className="num">{pv.current[k]}</td>
                    <td className="num">{pv.manifest.counts[k]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pv.warnings.map((w: string) => (
              <p key={w}>{w}</p>
            ))}
            <Field label="置き換える場合は「復元します」と入力">
              <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
            </Field>
            <div className="btn-row">
              <button className="btn" onClick={async () => (await post(`/api/backup/restore/${pv.stagingId}/discard`).catch(() => null), setPv(null))}>
                やめる
              </button>
              <button
                className="btn btn-danger"
                disabled={confirmText !== '復元します'}
                onClick={async () => {
                  try {
                    await post(`/api/backup/restore/${pv.stagingId}/commit`);
                    setPv(null);
                    setDone('復元しました。新しいデータ世代に切り替わりました。');
                    await refresh();
                    status.reload();
                  } catch (e) {
                    setErr(e);
                  }
                }}
              >
                現在のデータを置き換えて復元する
              </button>
            </div>
          </div>
        )}
        {done && <p className="msg msg-ok">{done}</p>}
        {status.data?.canRollback && me?.mode === 'live' && (
          <button
            className="btn"
            onClick={async () => {
              if (!confirm('直前の復元を取り消して、復元前のデータに戻しますか？')) return;
              try {
                await post('/api/backup/rollback');
                setDone('復元前のデータに戻しました。');
                await refresh();
                status.reload();
              } catch (e) {
                setErr(e);
              }
            }}
          >
            直前の復元を元に戻す
          </button>
        )}
      </div>
    </div>
  );
}

export function DraftsPage() {
  const { account, me } = useApp();
  const [list, setList] = useState<DeviceDraft[] | null>(null);
  const nav = useNavigate();
  const load = () => listDrafts(account).then(setList);
  useEffect(() => {
    if (account) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);
  return (
    <div>
      <h1>端末下書き</h1>
      <p className="small muted">
        この端末のブラウザ内に保存した、まだサーバーで確定していない入力です。在庫は変わっていません。端末の保存はバックアップではなく、ブラウザの判断や容量不足で消えることがあります。再接続しても自動では確定しません。開いて最新の数量を確認してから送信してください。
      </p>
      {!list && <Loading />}
      {list?.length === 0 && <Empty>端末下書きはありません</Empty>}
      {list?.map((d) => {
        const stale = d.dataEpoch !== me?.dataEpoch;
        return (
          <div className="card" key={d.id}>
            <div>
              <strong>{d.title}</strong>
            </div>
            <div className="small muted">
              保存 {fmtDateTime(d.savedAt)} ／ 状態 {d.status === 'unknown' ? '結果確認中（送信済みの可能性あり）' : '未送信'}
              {stale && <span className="badge badge-err"> データ世代が異なるため送信不可</span>}
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" onClick={() => nav(`${d.payload.route}?draft=${d.id}`)}>
                開いて確認
              </button>
              {d.status === 'unknown' && (
                <button
                  className="btn"
                  onClick={async () => {
                    const r = await get(`/api/ops/by-key/${d.id}`).catch(() => null);
                    if (r?.found) {
                      await removeDraft(d.id);
                      alert('この操作はサーバーで確定済みでした。下書きを削除しました。');
                      load();
                    } else alert(r ? 'サーバーには届いていません。開いて確認してから送信してください。' : '確認できませんでした（通信を確認してください）');
                  }}
                >
                  処理状況を確認
                </button>
              )}
              <button
                className="btn btn-danger"
                onClick={async () => {
                  if (!confirm('この下書きを削除しますか？（在庫には影響しません）')) return;
                  await removeDraft(d.id);
                  load();
                }}
              >
                削除
              </button>
            </div>
          </div>
        );
      })}
      {list && list.length > 0 && (
        <button className="btn btn-danger" onClick={async () => confirm('この端末の下書きをすべて削除しますか？') && (await removeAllDrafts(account), load())}>
          すべて削除
        </button>
      )}
    </div>
  );
}

export function Settings() {
  const { me, refresh, account, switchMode } = useApp();
  const nav = useNavigate();
  const [pw, setPw] = useState({ current: '', next: '' });
  const [del, setDel] = useState({ password: '', confirm: '' });
  const [err, setErr] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const logout = async (all: boolean) => {
    const n = (await listDrafts(account)).length;
    if (n && !confirm(`この端末に未送信の下書きが${n}件あります。ログアウトしても下書きは端末に残り、同じアカウントで再ログインしたときだけ表示されます。ログアウトしますか？`)) return;
    await post(all ? '/api/auth/logout-all' : '/api/auth/logout').catch(() => null);
    await refresh();
    nav('/login');
  };
  return (
    <div>
      <h1>アカウント・データ</h1>
      <div className="card small">
        <dl className="kv">
          <dt>事業者</dt>
          <dd>{me?.businessName}</dd>
          <dt>メール</dt>
          <dd>{me?.email}</dd>
          <dt>利用権</dt>
          <dd>
            {me?.entitlement === 'active' ? '有効' : me?.entitlement === 'pending' ? '付与待ち' : '停止中'}
            {me?.entitlementUntil && `（${me.entitlementUntil}まで）`}
          </dd>
          <dt>表示中のデータ</dt>
          <dd>{me?.mode === 'sample' ? 'サンプル（架空）' : '本番'}</dd>
        </dl>
      </div>
      <div className="btn-row">
        <button className="btn" onClick={() => logout(false)}>
          ログアウト
        </button>
        <button className="btn" onClick={() => logout(true)}>
          すべての端末からログアウト
        </button>
        {me?.mode === 'sample' && (
          <button className="btn" onClick={() => switchMode('sample', true).then(() => setMsg('サンプルを初期状態に戻しました'))}>
            サンプルを初期状態に戻す
          </button>
        )}
      </div>
      {msg && <p className="msg msg-ok">{msg}</p>}
      <ErrorMsg error={err} />
      <div className="card">
        <h2 style={{ marginTop: 0 }}>パスワード変更</h2>
        <Field label="現在のパスワード">
          <input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
        </Field>
        <Field label="新しいパスワード（10文字以上）">
          <input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        </Field>
        <button
          className="btn"
          onClick={async () => {
            try {
              await post('/api/auth/password', pw);
              await refresh();
              nav('/login');
            } catch (e) {
              setErr(e);
            }
          }}
        >
          変更する（全端末でログアウトされます）
        </button>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>データの書き出し</h2>
        <Link to="/backup" className="btn">
          バックアップ（全データZIP）
        </Link>{' '}
        <Link to="/csv" className="btn">
          CSV出力
        </Link>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>アカウント削除</h2>
        <p className="small">
          本番・サンプル・復元前の退避データ、商品写真、ログイン情報を削除します。取り消せません。運営者のサーバーバックアップに残る期間は <Link to="/privacy">データの取り扱い</Link> を確認してください。先にバックアップを書き出すことをおすすめします。
        </p>
        <Field label="パスワード">
          <input type="password" value={del.password} onChange={(e) => setDel({ ...del, password: e.target.value })} />
        </Field>
        <Field label="確認のため「削除します」と入力">
          <input value={del.confirm} onChange={(e) => setDel({ ...del, confirm: e.target.value })} />
        </Field>
        <button
          className="btn btn-danger"
          disabled={del.confirm !== '削除します' || !del.password}
          onClick={async () => {
            try {
              await post('/api/account/delete', del);
              await removeAllDrafts(account);
              await refresh();
              nav('/login');
            } catch (e) {
              setErr(e);
            }
          }}
        >
          アカウントと全データを削除
        </button>
      </div>
    </div>
  );
}

export function Help() {
  return (
    <div>
      <h1>使い方</h1>
      <div className="card small">
        <h2 style={{ marginTop: 0 }}>基本の流れ</h2>
        <ol>
          <li>保管場所・仕入先・商品（SKU）を登録し、初期在庫を場所ごとに登録します。</li>
          <li>補充：利用可能と発注残から補充候補を確認し、仕入先別に発注下書きを作ります。</li>
          <li>発注：数量発注書PDFを仕入先へ送り、実際に発注したら「発注済みにする」。</li>
          <li>入庫：届いたら入荷待ちから発注を開き、今回の数量と入庫先を入力して確定（分納OK、不良は保留へ）。</li>
          <li>移動・出庫：棚→イベントケースなどへの移動、販売・サンプル等の出庫を記録します。</li>
          <li>棚卸：場所を停止して数え、差異に理由を付けて確定します。</li>
        </ol>
        <h2>スマホで使う</h2>
        <ul>
          <li>iPhone：Safariで開き、共有ボタン→「ホーム画面に追加」。Android：Chromeのメニュー→「アプリをインストール」。追加しなくても使えます。</li>
          <li>「📷 読取」でJAN・EAN・アプリ内部QRを読み取ります。読み取っても数量は自動で加算しません。</li>
          <li>USB等のバーコードスキャナーは、検索欄にカーソルを置いて読み取る（Enterで検索）と使えます。</li>
          <li>通信がないときは確定できません。入力は「端末に下書き保存」で残せます。</li>
        </ul>
        <h2>困ったとき</h2>
        <ul>
          <li>「結果確認中」と出たら、「処理状況を確認」を押してください。新しい操作としてやり直すと二重登録の原因になります。</li>
          <li>在庫が足りないと表示されたら、他の場所の数量を確認し、移動してから出庫してください。</li>
          <li>誤って登録したときは、履歴の「取消」を使います。実際に商品が戻ったときは返品を使います。</li>
        </ul>
      </div>
    </div>
  );
}

export function Privacy() {
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '1rem' }}>
      <h1>データの取り扱い</h1>
      <div className="card small">
        <p>業務データはアカウント専用のクラウド領域に保存されます。カメラのコード読み取り映像は端末内で処理します。商品写真は選択して登録したものだけ保存します。</p>
        <ul>
          <li>保存先：運営者が契約するクラウドのデータベースと非公開ストレージ。他の利用者からは参照できないよう、全データを事業者ごとに分離しています。</li>
          <li>通信：HTTPSで暗号化します。保存時の暗号化は、採用するクラウド事業者の機能に依存します（販売開始時に具体名を記載）。</li>
          <li>運営者の取扱い：障害対応・復旧のために必要な範囲でのみアクセスします。操作ログにはパスワード・CSVの本文・仕入先の連絡先は記録しません。</li>
          <li>外部連携：銀行・EC・メール・SNS・外部AIへは接続しません。カメラ映像を外部の画像認識サービスへ送信しません。</li>
          <li>端末内の保存：未送信の下書きのみ、ブラウザ内に保存します。バックアップではありません。</li>
          <li>削除：アカウント削除で、現在のデータ・サンプル・退避データ・写真を削除します。運営者のサーバーバックアップからの消去時期は、保持期間の終了後です（期間は販売開始前に確定し、ここに記載します）。</li>
        </ul>
        <p>
          <Link to="/">戻る</Link>
        </p>
      </div>
    </div>
  );
}
