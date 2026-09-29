import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { useApp } from '../lib/app-context';
import { countDrafts } from '../lib/drafts';

const side: [string, string, string][] = [
  ['業務', '/', 'ホーム'],
  ['', '/receive', '入庫（入荷待ち）'],
  ['', '/issue', '出庫'],
  ['', '/transfer', '移動'],
  ['', '/stocktakes', '棚卸'],
  ['', '/replenish', '補充'],
  ['', '/more/ops', 'その他の操作'],
  ['一覧', '/inventory', '在庫'],
  ['', '/pos', '発注'],
  ['', '/history', '履歴'],
  ['', '/drafts', '端末下書き'],
  ['設定', '/skus/new', '商品を登録'],
  ['', '/locations', '保管場所'],
  ['', '/suppliers', '仕入先'],
  ['', '/labels', 'QRラベル'],
  ['', '/csv', 'CSV取込・出力'],
  ['', '/backup', 'バックアップ'],
  ['', '/settings', 'アカウント'],
  ['', '/help', '使い方'],
];

export function Layout({ children }: { children: ReactNode }) {
  const { me, online, lastSync, epochChanged, refresh, account } = useApp();
  const [drafts, setDrafts] = useState(0);
  useEffect(() => {
    if (account) countDrafts(account).then(setDrafts);
  }, [account, children]);
  const sync = lastSync ? new Date(lastSync).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '—';
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          StockPilot
        </Link>
        {me?.mode === 'sample' && <span className="badge badge-sample">サンプル表示中</span>}
        {!online && <span className="badge badge-offline">オフライン（確定できません）</span>}
        <span className="spacer" />
        <span className="small muted hide-mobile">{me?.businessName}</span>
        <button className="btn btn-small" onClick={() => refresh().then(() => window.dispatchEvent(new Event('sp:refresh')))} aria-label="最新の状態に更新">
          ⟳ <span className="small">最終同期 {sync}</span>
        </button>
      </header>
      {epochChanged && (
        <div className="banner banner-err" role="alert">
          データが復元または切り替えられました。古い画面のまま確定はできません。{' '}
          <button className="btn btn-small" onClick={() => window.location.reload()}>
            再読み込み
          </button>
        </div>
      )}
      {me && me.mode === 'live' && !me.canWriteLive && (
        <div className="banner banner-warn">利用権の付与待ち、または停止中です。本番データの登録・確定はできません。サンプルで操作を試せます。</div>
      )}
      {drafts > 0 && (
        <div className="banner banner-warn">
          未送信の端末下書きが{drafts}件あります。 <Link to="/drafts">確認する</Link>
        </div>
      )}
      <div className="layout">
        <nav className="sidenav" aria-label="メインメニュー">
          {side.map(([g, to, label]) => (
            <div key={to}>
              {g && <div className="group">{g}</div>}
              <NavLink to={to} end={to === '/'}>
                {label}
              </NavLink>
            </div>
          ))}
        </nav>
        <main id="main">{children}</main>
      </div>
      <nav className="bottomnav" aria-label="下部メニュー">
        <NavLink to="/" end>
          <span className="ico" aria-hidden>
            🏠
          </span>
          ホーム
        </NavLink>
        <NavLink to="/inventory">
          <span className="ico" aria-hidden>
            📦
          </span>
          在庫
        </NavLink>
        <NavLink to="/more/ops">
          <span className="ico" aria-hidden>
            ⇄
          </span>
          操作
        </NavLink>
        <NavLink to="/receive">
          <span className="ico" aria-hidden>
            🚚
          </span>
          入荷待ち
        </NavLink>
        <NavLink to="/more">
          <span className="ico" aria-hidden>
            ☰
          </span>
          その他
        </NavLink>
      </nav>
    </div>
  );
}
