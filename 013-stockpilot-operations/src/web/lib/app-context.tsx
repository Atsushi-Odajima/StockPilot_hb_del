import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, onApiEvent, post, setEpoch } from './api';

export interface Me {
  email: string;
  businessName: string;
  mode: 'live' | 'sample';
  dataEpoch: string;
  entitlement: string;
  entitlementUntil: string | null;
  canWriteLive: boolean;
}

interface AppState {
  me: Me | null;
  loading: boolean;
  online: boolean;
  lastSync: number;
  epochChanged: boolean;
  refresh: () => Promise<void>;
  switchMode: (mode: 'live' | 'sample', reset?: boolean) => Promise<void>;
  account: string;
}

const Ctx = createContext<AppState>(null as unknown as AppState);
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(navigator.onLine);
  const [lastSync, setLastSync] = useState(0);
  const [epochChanged, setEpochChanged] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const m = await get<Me>('/api/me');
      setEpoch(m.dataEpoch);
      setMe(m);
      setEpochChanged(false);
      setLastSync(Date.now());
    } catch (e) {
      if ((e as { status?: number }).status === 401) setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const off = onApiEvent((e) => {
      if (e.type === 'auth') setMe(null);
      if (e.type === 'epoch') setEpochChanged(true);
      if (e.type === 'online') {
        setOnline(!!e.value);
        if (e.value) setLastSync(Date.now());
      }
    });
    const on = () => setOnline(true);
    const offl = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', offl);
    return () => {
      off();
      window.removeEventListener('online', on);
      window.removeEventListener('offline', offl);
    };
  }, [refresh]);

  const switchMode = useCallback(
    async (mode: 'live' | 'sample', reset?: boolean) => {
      const r = await post<{ dataEpoch: string }>('/api/mode', { mode, reset });
      setEpoch(r.dataEpoch);
      await refresh();
    },
    [refresh],
  );

  const account = me ? `${me.businessName}|${me.email}` : '';
  return <Ctx.Provider value={{ me, loading, online, lastSync, epochChanged, refresh, switchMode, account }}>{children}</Ctx.Provider>;
}
