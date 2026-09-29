import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import './styles.css';
import { AppProvider, useApp } from './lib/app-context';
import { Layout } from './components/Layout';
import { Login, Register, Forgot, Reset } from './pages/Auth';
import { Home, Welcome, More, MoreOps } from './pages/Home';
import { InventoryList, SkuDetail, SkuEdit, IdleList } from './pages/Inventory';
import { LinesOpPage, TransferPage, OpDetail, HistoryPage } from './pages/Ops';
import { PendingList, ReceivePo, CustomerReturn, SupplierReturn } from './pages/Receive';
import { PoList, PoDetail, PoEdit, Replenish } from './pages/Purchase';
import { StocktakeList, StocktakeSession } from './pages/Stocktake';
import { Locations, LocationDetail, Suppliers } from './pages/Masters';
import { CsvPage, BackupPage, DraftsPage, Settings, Help, Privacy } from './pages/Data';
import { Labels } from './pages/Docs';
import { Loading } from './components/ui';

function Protected({ children }: { children: ReactNode }) {
  const { me, loading } = useApp();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return <Layout>{children}</Layout>;
}

/** 新しい版の配信：入力中の内容を消さないよう、利用者が明示的に更新するまで待つ */
function UpdateBanner() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          sw?.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) setWaiting(sw);
          });
        });
        setInterval(() => reg.update().catch(() => undefined), 30 * 60_000);
      })
      .catch(() => undefined);
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloaded && sessionStorage.getItem('sp-update') === '1') {
        reloaded = true;
        sessionStorage.removeItem('sp-update');
        window.location.reload();
      }
    });
  }, []);
  if (!waiting) return null;
  return (
    <div className="banner banner-warn" role="status" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 200 }}>
      新しい版があります。入力中の内容を確定または下書き保存してから更新してください。{' '}
      <button
        className="btn btn-small"
        onClick={() => {
          sessionStorage.setItem('sp-update', '1');
          waiting.postMessage('SKIP_WAITING');
        }}
      >
        更新する
      </button>
    </div>
  );
}

function App() {
  const P = (el: ReactNode) => <Protected>{el}</Protected>;
  return (
    <>
      <UpdateBanner />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot" element={<Forgot />} />
        <Route path="/reset" element={<Reset />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/" element={P(<Home />)} />
        <Route path="/welcome" element={P(<Welcome />)} />
        <Route path="/more" element={P(<More />)} />
        <Route path="/more/ops" element={P(<MoreOps />)} />
        <Route path="/inventory" element={P(<InventoryList />)} />
        <Route path="/idle" element={P(<IdleList />)} />
        <Route path="/skus/new" element={P(<SkuEdit />)} />
        <Route path="/skus/:id" element={P(<SkuDetail />)} />
        <Route path="/skus/:id/edit" element={P(<SkuEdit />)} />
        <Route path="/issue" element={P(<LinesOpPage kind="issue" key="issue" />)} />
        <Route path="/more/outside-receipt" element={P(<LinesOpPage kind="outside-receipt" key="or" />)} />
        <Route path="/more/disposal" element={P(<LinesOpPage kind="disposal" key="dp" />)} />
        <Route path="/more/correction" element={P(<LinesOpPage kind="correction" key="cr" />)} />
        <Route path="/more/initial" element={P(<LinesOpPage kind="initial" key="in" />)} />
        <Route path="/more/customer-return" element={P(<CustomerReturn />)} />
        <Route path="/more/supplier-return" element={P(<SupplierReturn />)} />
        <Route path="/transfer" element={P(<TransferPage />)} />
        <Route path="/receive" element={P(<PendingList />)} />
        <Route path="/receive/:id" element={P(<ReceivePo />)} />
        <Route path="/ops/:id" element={P(<OpDetail />)} />
        <Route path="/history" element={P(<HistoryPage />)} />
        <Route path="/pos" element={P(<PoList />)} />
        <Route path="/pos/new" element={P(<PoEdit mode="new" key="new" />)} />
        <Route path="/pos/:id" element={P(<PoDetail />)} />
        <Route path="/pos/:id/edit" element={P(<PoEdit mode="edit" key="edit" />)} />
        <Route path="/pos/:id/revise" element={P(<PoEdit mode="revise" key="revise" />)} />
        <Route path="/replenish" element={P(<Replenish />)} />
        <Route path="/stocktakes" element={P(<StocktakeList />)} />
        <Route path="/stocktakes/:id" element={P(<StocktakeSession />)} />
        <Route path="/locations" element={P(<Locations />)} />
        <Route path="/locations/:id" element={P(<LocationDetail />)} />
        <Route path="/suppliers" element={P(<Suppliers />)} />
        <Route path="/labels" element={P(<Labels />)} />
        <Route path="/csv" element={P(<CsvPage />)} />
        <Route path="/backup" element={P(<BackupPage />)} />
        <Route path="/drafts" element={P(<DraftsPage />)} />
        <Route path="/settings" element={P(<Settings />)} />
        <Route path="/help" element={P(<Help />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </StrictMode>,
);
