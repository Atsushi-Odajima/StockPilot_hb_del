import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useApp } from '../lib/app-context';
import { ErrorMsg, Loading, StatusLink, useFetch } from '../components/ui';

export function Home() {
  const { me } = useApp();
  const { data, error, loading } = useFetch<any>('/api/dashboard', [me?.dataEpoch]);
  return (
    <div>
      <h1>{me?.mode === 'sample' ? 'サンプル（架空データ）' : 'ホーム'}</h1>
      <div className="grid-actions">
        <Link to="/receive" className="action-tile">
          <span className="ico" aria-hidden>
            📥
          </span>
          入庫
        </Link>
        <Link to="/issue" className="action-tile">
          <span className="ico" aria-hidden>
            📤
          </span>
          出庫
        </Link>
        <Link to="/transfer" className="action-tile">
          <span className="ico" aria-hidden>
            ⇄
          </span>
          移動
        </Link>
        <Link to="/stocktakes" className="action-tile">
          <span className="ico" aria-hidden>
            🔢
          </span>
          棚卸
        </Link>
        <Link to="/replenish" className="action-tile">
          <span className="ico" aria-hidden>
            🛒
          </span>
          補充
        </Link>
      </div>
      <h2>今の状況</h2>
      {loading && <Loading />}
      <ErrorMsg error={error} />
      {data && (
        <div className="stats">
          <StatusLink to="/inventory" n={data.active_skus} label="稼働SKU数" />
          <StatusLink to="/inventory?filter=zero" n={data.zero_skus} label="在庫0のSKU" tone="err" />
          <StatusLink to="/inventory?filter=below_safety" n={data.below_safety} label="安全在庫割れ" tone="err" />
          <StatusLink to="/replenish" n={data.replenish_candidates} label="補充候補" />
          <StatusLink to="/receive" n={data.pending_lines} label="入荷待ち明細" />
          <StatusLink to="/receive?overdue=1" n={data.overdue_lines} label="納期超過" tone="err" />
          <StatusLink to="/stocktakes" n={data.active_stocktakes} label="棚卸進行中" />
          <StatusLink to="/inventory?filter=hold" n={data.hold_skus} label="保留在庫のあるSKU" />
          <StatusLink to="/pos?status=draft" n={data.draft_pos} label="発注下書き" />
          <StatusLink to="/idle" n={data.idle_90d} label="90日以上 出庫なし" />
        </div>
      )}
      <p className="small muted">売上・利益・金額は扱いません。数量と日数だけを表示します。</p>
    </div>
  );
}

export function Welcome() {
  const { switchMode } = useApp();
  const nav = useNavigate();
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <h1>はじめに</h1>
      <p>StockPilot は「現物を間違えずに動かす」ための道具です。商品（SKU）ごと・保管場所ごとの数量と、その変更履歴を記録します。</p>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>1. サンプルで試す（3分）</h2>
        <p className="small">架空の商品22件・保管場所4件・仕入先3件が入った別領域で操作できます。本番のデータは変わりません。</p>
        <ol className="small">
          <li>「在庫」で商品を検索し、場所ごとの数量を見る</li>
          <li>「入庫」で入荷待ちの発注を開き、届いた数量を入力して確認する</li>
          <li>「履歴」で記録された伝票を確認する</li>
        </ol>
        <ErrorMsg error={err} />
        <button
          className="btn btn-primary btn-block"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await switchMode('sample');
              nav('/inventory');
            } catch (e) {
              setErr(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          サンプルを試す
        </button>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>2. 自分の商品と保管場所を登録</h2>
        <ol className="small">
          <li>
            <Link to="/locations">保管場所</Link>（棚・箱・イベントケース、検品保留箱）を作る
          </li>
          <li>
            <Link to="/suppliers">仕入先</Link>を登録（発注する場合）
          </li>
          <li>
            <Link to="/skus/new">商品（SKU）</Link>を登録、またはCSVで一括登録
          </li>
          <li>
            <Link to="/more/initial">初期在庫</Link>を場所ごとに登録
          </li>
        </ol>
        <Link to="/locations" className="btn btn-block">
          保管場所から始める
        </Link>
      </div>
      <div className="card small">
        <strong>用語</strong>
        <dl className="kv">
          <dt>発注済み</dt>
          <dd>仕入先に注文したことの記録。在庫はまだ増えません。</dd>
          <dt>入庫（届いた）</dt>
          <dd>現物が届き、場所に置いたことの記録。ここで在庫が増えます。</dd>
          <dt>利用可能</dt>
          <dd>通常の場所にある数量。保留場所の数量は含めません。</dd>
          <dt>発注残</dt>
          <dd>発注済みで、まだ届いていない数量。現物在庫ではありません。</dd>
        </dl>
      </div>
    </div>
  );
}

export function MoreOps() {
  const items: [string, string, string][] = [
    ['/receive', '発注の入荷（入庫）', '入荷待ちの発注から受領'],
    ['/more/outside-receipt', '発注外入庫', '発注にない入庫（理由必須）'],
    ['/issue', '出庫', '販売・サンプル配布・業務使用など'],
    ['/transfer', '場所移動', '棚→ケース、保留→通常（検品解除）'],
    ['/more/customer-return', '顧客返品', '戻った商品を検品保留へ'],
    ['/more/supplier-return', '仕入先返品', '受領した商品を仕入先へ返送'],
    ['/more/disposal', '破損・廃棄', '実際に廃棄した数量を減らす'],
    ['/more/correction', '理由付き数量訂正', '事実に基づく増減の訂正'],
    ['/more/initial', '初期在庫', '履歴のないSKU×場所に最初の数量'],
    ['/history', '誤登録の取消', '履歴から取り消す操作を選ぶ'],
  ];
  return (
    <div>
      <h1>操作</h1>
      <div className="cards">
        {items.map(([to, t, d]) => (
          <Link key={to + t} to={to} className="item">
            <div>
              <strong>{t}</strong>
              <div className="small muted">{d}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function More() {
  const { me, switchMode } = useApp();
  const nav = useNavigate();
  const items: [string, string][] = [
    ['/replenish', '補充候補'],
    ['/pos', '発注一覧'],
    ['/stocktakes', '棚卸'],
    ['/history', '入出庫履歴'],
    ['/drafts', '端末下書き'],
    ['/skus/new', '商品を登録'],
    ['/locations', '保管場所'],
    ['/suppliers', '仕入先'],
    ['/labels', 'QRラベル印刷'],
    ['/csv', 'CSV取込・出力'],
    ['/backup', 'バックアップ・復元'],
    ['/settings', 'アカウント・データ'],
    ['/help', '使い方'],
    ['/privacy', 'データの取り扱い'],
  ];
  return (
    <div>
      <h1>その他</h1>
      <div className="card">
        {me?.mode === 'sample' ? (
          <button className="btn btn-block" onClick={() => switchMode('live').then(() => nav('/'))}>
            本番データに戻る
          </button>
        ) : (
          <button className="btn btn-block" onClick={() => switchMode('sample').then(() => nav('/'))}>
            サンプルを表示（本番とは別領域）
          </button>
        )}
      </div>
      <div className="cards">
        {items.map(([to, t]) => (
          <Link key={to} to={to} className="item">
            {t}
          </Link>
        ))}
      </div>
    </div>
  );
}
