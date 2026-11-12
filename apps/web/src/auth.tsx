import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { can as canDo, type Action, type Module, type PermissionSet, type Role } from '@mailvault/shared';
import { api } from './api';

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

interface AuthState {
  user: SessionUser | null;
  permissions: PermissionSet;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (module: Module, action?: Action) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [permissions, setPermissions] = useState<PermissionSet>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ user: SessionUser; permissions: PermissionSet }>('/api/auth/me')
      .then((r) => {
        setUser(r.user);
        setPermissions(r.permissions);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));

    const onUnauthorized = () => setUser(null);
    window.addEventListener('mv:unauthorized', onUnauthorized);
    return () => window.removeEventListener('mv:unauthorized', onUnauthorized);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const r = await api.post<{ user: SessionUser; permissions: PermissionSet }>('/api/auth/login', { username, password });
    setUser(r.user);
    setPermissions(r.permissions);
  }, []);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    setUser(null);
    setPermissions({});
  }, []);

  const can = useCallback((module: Module, action: Action = 'view') => canDo(permissions, module, action), [permissions]);

  return <AuthContext.Provider value={{ user, permissions, loading, login, logout, can }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
