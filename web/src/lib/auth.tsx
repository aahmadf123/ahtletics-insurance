import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SessionUser } from '../types';
import { getMe } from './api';

interface AuthCtx {
  user: SessionUser | null;
  loading: boolean;
  reload: () => void;
}

const AuthContext = createContext<AuthCtx>({ user: null, loading: true, reload: () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]     = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = () => {
    setLoading(true);
    getMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  };

  useEffect(reload, []);

  return <AuthContext.Provider value={{ user, loading, reload }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
