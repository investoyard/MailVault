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
  mustChangePassword: boolean;
  passwordChanged: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [permissions, setPermissions] = useState<PermissionSet>({});
  const [loading, setLoading] = useState(true);
  const [mustChangePassword, setMustChange] = useState(false);

  useEffect(() => {
    api
      .get<{ user: SessionUser; permissions: PermissionSet; mustChangePassword: boolean }>('/api/auth/me')
      .then((r) => {
        setUser(r.user);
        setPermissions(r.permissions);
        setMustChange(r.mustChangePassword);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));

    const onUnauthorized = () => setUser(null);
    window.addEventListener('mv:unauthorized', onUnauthorized);
    return () => window.removeEventListener('mv:unauthorized', onUnauthorized);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const r = await api.post<{ user: SessionUser; permissions: PermissionSet; mustChangePassword: boolean }>('/api/auth/login', { username, password });
    setUser(r.user);
    setPermissions(r.permissions);
    setMustChange(r.mustChangePassword);
  }, []);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    setUser(null);
    setPermissions({});
  }, []);

  const can = useCallback((module: Module, action: Action = 'view') => canDo(permissions, module, action), [permissions]);

  const passwordChanged = useCallback(() => setMustChange(false), []);

  return (
    <AuthContext.Provider value={{ user, permissions, loading, login, logout, can, mustChangePassword, passwordChanged }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
