import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { post } from '../lib/api';
import { useApp } from '../lib/app-context';
import { ErrorMsg, Field } from '../components/ui';

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 440, margin: '0 auto', padding: '1.2rem 1rem' }}>
      <h1 style={{ color: '#174a96' }}>StockPilot</h1>
      <p className="muted small">何がどこに何個あり、あと何個届き、次に何個補充すればよいかを確認できます。</p>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Login() {
  const { refresh } = useApp();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Shell title="ログイン">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await post('/api/auth/login', { email, password });
            await refresh();
            nav('/');
          } catch (e2) {
            setErr(e2);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="メールアドレス">
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="パスワード">
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <ErrorMsg error={err} />
        <button className="btn btn-primary btn-block" disabled={busy}>
          ログイン
        </button>
      </form>
      <p className="small">
        <Link to="/register">新規登録</Link> ／ <Link to="/forgot">パスワードを忘れた</Link>
      </p>
    </Shell>
  );
}

export function Register() {
  const { refresh } = useApp();
  const nav = useNavigate();
  const [f, setF] = useState({ email: '', password: '', businessName: '' });
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Shell title="新規登録">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await post('/api/auth/register', f);
            await refresh();
            nav('/welcome');
          } catch (e2) {
            setErr(e2);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="事業者名（表示・帳票の発注者名）">
          <input value={f.businessName} onChange={(e) => setF({ ...f, businessName: e.target.value })} maxLength={100} required />
        </Field>
        <Field label="メールアドレス">
          <input type="email" autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        </Field>
        <Field label="パスワード（10文字以上）">
          <input type="password" autoComplete="new-password" minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
        </Field>
        <div className="msg msg-info small">
          業務データはアカウント専用のクラウド領域に保存されます。カメラのコード読み取り映像は端末内で処理します。商品写真は選択して登録したものだけ保存します。
          <Link to="/privacy"> データの取り扱い</Link>
        </div>
        <label className="check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> 上記と注意事項を確認しました
        </label>
        <ErrorMsg error={err} />
        <button className="btn btn-primary btn-block" disabled={busy || !agree}>
          登録する
        </button>
      </form>
      <p className="small">
        <Link to="/login">ログインへ戻る</Link>
      </p>
    </Shell>
  );
}

export function Forgot() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Shell title="パスワード再設定">
      {done ? (
        <p className="msg msg-ok">登録があれば、再設定の案内をメールで送りました。30分以内に手続きしてください。</p>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await post('/api/auth/reset-request', { email });
              setDone(true);
            } catch (e2) {
              setErr(e2);
            }
          }}
        >
          <Field label="登録したメールアドレス">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <ErrorMsg error={err} />
          <button className="btn btn-primary btn-block">案内を送る</button>
        </form>
      )}
      <p className="small">
        <Link to="/login">ログインへ戻る</Link>
      </p>
    </Shell>
  );
}

export function Reset() {
  const [sp] = useSearchParams();
  const [pw, setPw] = useState('');
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Shell title="新しいパスワード">
      {done ? (
        <p className="msg msg-ok">
          再設定しました。<Link to="/login">ログイン</Link>してください。他の端末のログインは解除されました。
        </p>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await post('/api/auth/reset', { token: sp.get('token') ?? '', password: pw });
              setDone(true);
            } catch (e2) {
              setErr(e2);
            }
          }}
        >
          <Field label="新しいパスワード（10文字以上）">
            <input type="password" autoComplete="new-password" minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} required />
          </Field>
          <ErrorMsg error={err} />
          <button className="btn btn-primary btn-block">設定する</button>
        </form>
      )}
    </Shell>
  );
}
