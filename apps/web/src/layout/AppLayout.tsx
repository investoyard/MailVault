import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar, Badge, Button, Dropdown, Layout, Menu, Tooltip, type MenuProps } from 'antd';
import {
  AppstoreOutlined,
  BellOutlined,
  CloudServerOutlined,
  ExperimentOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  LogoutOutlined,
  MailOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  NodeIndexOutlined,
  ProfileOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
  InboxOutlined,
  ThunderboltOutlined,
  KeyOutlined,
  ApiOutlined,
  ContactsOutlined,
  ControlOutlined,
  DatabaseOutlined,
  MonitorOutlined,
} from '@ant-design/icons';
import { ChangePasswordModal, PreferencesModal } from '../components/AccountModals';
import { useConfirm } from '../components/confirm';
import type { Module } from '@mailvault/shared';
import { useAuth } from '../auth';
import { api } from '../api';
import { fromNow } from '../format';

const { Sider, Header, Content } = Layout;

interface NavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  module: Module;
}

interface NavGroup {
  key: string;
  label: string;
  icon: React.ReactNode;
  items: NavItem[];
}

const HOME: NavItem = { key: '/', label: 'Dashboard', icon: <AppstoreOutlined />, module: 'dashboard' };

const NAV: NavGroup[] = [
  {
    key: 'grp:mail',
    label: 'Mail Automation',
    icon: <MailOutlined />,
    items: [
      { key: '/accounts', label: 'Email Accounts', icon: <ContactsOutlined />, module: 'accounts' },
      { key: '/rules', label: 'Download Rules', icon: <NodeIndexOutlined />, module: 'rules' },
      { key: '/rule-testing', label: 'Rule Testing', icon: <ExperimentOutlined />, module: 'ruleTesting' },
      { key: '/historical-jobs', label: 'Historical Jobs', icon: <HistoryOutlined />, module: 'ruleTesting' },
    ],
  },
  {
    key: 'grp:records',
    label: 'Records',
    icon: <DatabaseOutlined />,
    items: [
      { key: '/history', label: 'Download History', icon: <FileSearchOutlined />, module: 'history' },
      { key: '/destinations', label: 'Destination Folders', icon: <FolderOpenOutlined />, module: 'destinations' },
    ],
  },
  {
    key: 'grp:monitoring',
    label: 'Monitoring',
    icon: <MonitorOutlined />,
    items: [
      { key: '/notifications', label: 'Notifications', icon: <BellOutlined />, module: 'notifications' },
      { key: '/logs', label: 'Audit & Logs', icon: <ProfileOutlined />, module: 'logs' },
      { key: '/system', label: 'System Status', icon: <CloudServerOutlined />, module: 'dashboard' },
    ],
  },
  {
    key: 'grp:admin',
    label: 'Administration',
    icon: <ControlOutlined />,
    items: [
      { key: '/users', label: 'Users & Roles', icon: <TeamOutlined />, module: 'users' },
      { key: '/integrations', label: 'Integrations', icon: <ApiOutlined />, module: 'settings' },
      { key: '/settings', label: 'Settings', icon: <SettingOutlined />, module: 'settings' },
    ],
  },
];

/** The parent group that contains a page, so it can be opened automatically. */
const groupOf = (path: string) => NAV.find((g) => g.items.some((i) => i.key === path))?.key;

const COLLAPSE_KEY = 'mv.sidebarCollapsed';
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
};

interface StatusResp {
  workers: { online: boolean; lastBeatAt: string; hostname: string }[];
}

interface NotificationRow {
  id: string;
  readAt: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  OPERATOR: 'Operator',
  VIEWER: 'Viewer',
};

export function AppLayout() {
  const { user, logout, can, mustChangePassword, passwordChanged } = useAuth();
  const confirm = useConfirm();
  const [pwOpen, setPwOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [collapsed, setCollapsedState] = useState(readCollapsed);
  const setCollapsed = (fn: (c: boolean) => boolean) =>
    setCollapsedState((c) => {
      const next = fn(c);
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* storage not available */
      }
      return next;
    });
  const selected = '/' + (pathname.split('/')[1] ?? '');
  const [openKeys, setOpenKeys] = useState<string[]>(() => {
    const g = groupOf(selected);
    return g ? [g] : [];
  });
  // Navigating to a page opens its parent (and closes the others).
  useEffect(() => {
    const g = groupOf(selected);
    if (g) setOpenKeys([g]);
  }, [selected]);
  // Accordion: only one parent open at a time; clicking an open parent closes it.
  const onOpenChange = (keys: string[]) => {
    const latest = keys.find((k) => !openKeys.includes(k));
    setOpenKeys(latest ? [latest] : []);
  };

  const status = useQuery({ queryKey: ['system-status'], queryFn: () => api.get<StatusResp>('/api/system/status'), refetchInterval: 30_000 });
  const notes = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<NotificationRow[]>('/api/notifications'), refetchInterval: 30_000 });

  // Live updates: the worker signals changes; refresh the affected screens (debounced).
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  useEffect(() => {
    const es = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | undefined;
    es.addEventListener('ready', () => setLive(true));
    es.addEventListener('change', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const key of ['dashboard', 'history', 'historical-jobs', 'mailboxes', 'notifications', 'destinations', 'system-status']) {
          void qc.invalidateQueries({ queryKey: [key] });
        }
      }, 800);
    });
    es.onerror = () => setLive(false);
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [qc]);
  const unread = notes.data?.filter((n) => !n.readAt).length ?? 0;
  const worker = status.data?.workers.find((w) => w.online) ?? status.data?.workers[0];

  const items: MenuProps['items'] = useMemo(() => {
    const groups = NAV.map((g) => ({
      key: g.key,
      icon: g.icon,
      label: g.label,
      popupClassName: 'mv-menu-popup',
      children: g.items.filter((i) => can(i.module)).map((i) => ({ key: i.key, icon: i.icon, label: i.label })),
    }))
      .filter((g) => g.children.length > 0)
      // Collapsed: the hover pop-out gets the parent's name as a small heading.
      .map((g) => (collapsed ? { ...g, children: [{ type: 'group' as const, key: `${g.key}:title`, label: g.label, children: g.children }] } : g));
    return [...(can(HOME.module) ? [{ key: HOME.key, icon: HOME.icon, label: HOME.label }] : []), ...groups];
  }, [can, collapsed]);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={248} collapsedWidth={72} collapsed={collapsed} className="mv-sider" trigger={null}>
        <div className="mv-brand" style={collapsed ? { justifyContent: 'center', padding: 0 } : undefined}>
          <div className="mv-brand-logo">
            <InboxOutlined />
          </div>
          {!collapsed && (
            <div>
              <div className="mv-brand-name">MailVault</div>
              <div className="mv-brand-sub">Attachment automation</div>
            </div>
          )}
        </div>
        <Menu
          mode="inline"
          className="mv-nav"
          selectedKeys={[selected]}
          items={items}
          onClick={(e) => navigate(e.key)}
          {...(collapsed ? {} : { openKeys, onOpenChange })}
          subMenuOpenDelay={0.05}
          subMenuCloseDelay={0.15}
        />
      </Sider>

      <Layout className="mv-main">
        <Header className="mv-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((c) => !c)}
              aria-label="Toggle menu"
            />
            <Tooltip title={worker ? `Host ${worker.hostname} · last heartbeat ${fromNow(worker.lastBeatAt)}` : 'The Worker service has not started yet'}>
              <span className="mv-pill" style={{ cursor: 'pointer' }} onClick={() => navigate('/system')}>
                <span
                  className={`mv-dot ${worker?.online ? 'pulse' : ''}`}
                  style={{ background: worker?.online ? '#16A34A' : '#DC2626' }}
                />
                {worker?.online ? 'Processing service running' : 'Processing service offline'}
              </span>
            </Tooltip>
            <Tooltip title={live ? 'Screens update automatically when emails are processed' : 'Live updates paused; data refreshes every 30 seconds'}>
              <span className="mv-pill" style={{ color: live ? '#3C2E7E' : '#94A3B8' }}>
                <ThunderboltOutlined /> {live ? 'Live' : 'Polling'}
              </span>
            </Tooltip>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Tooltip title="Notifications">
              <Badge count={unread} size="small" offset={[-4, 4]}>
                <Button type="text" shape="circle" icon={<BellOutlined style={{ fontSize: 18 }} />} onClick={() => navigate('/notifications')} />
              </Badge>
            </Tooltip>
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  {
                    key: 'role',
                    disabled: true,
                    icon: <SafetyCertificateOutlined />,
                    label: ROLE_LABEL[user?.role ?? ''] ?? user?.role,
                  },
                  { type: 'divider' },
                  { key: 'prefs', icon: <BellOutlined />, label: 'My notification preferences' },
                  { key: 'password', icon: <KeyOutlined />, label: 'Change password' },
                  { type: 'divider' },
                  { key: 'logout', icon: <LogoutOutlined />, label: 'Sign out', danger: true },
                ],
                onClick: (e) => {
                  if (e.key === 'logout')
                    void confirm({
                      tone: 'primary',
                      icon: <LogoutOutlined />,
                      title: 'Sign out of MailVault?',
                      description: 'You will need to sign in again to continue. Background processing keeps running.',
                      okText: 'Sign out',
                      onConfirm: logout,
                    });
                  if (e.key === 'password') setPwOpen(true);
                  if (e.key === 'prefs') setPrefsOpen(true);
                },
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <Avatar style={{ background: '#EFECF8', color: '#3C2E7E', fontWeight: 600 }}>
                  {user?.displayName?.[0]?.toUpperCase() ?? 'U'}
                </Avatar>
                <div style={{ lineHeight: 1.25 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{user?.displayName}</div>
                  <div className="mv-muted" style={{ fontSize: 12 }}>
                    {ROLE_LABEL[user?.role ?? '']}
                  </div>
                </div>
              </div>
            </Dropdown>
          </div>
        </Header>
        <Content>
          <div className="mv-content">
            <Outlet />
          </div>
          <ChangePasswordModal open={mustChangePassword || pwOpen} forced={mustChangePassword} onDone={() => { passwordChanged(); setPwOpen(false); }} />
          <PreferencesModal open={prefsOpen} onClose={() => setPrefsOpen(false)} />
        </Content>
      </Layout>
    </Layout>
  );
}
