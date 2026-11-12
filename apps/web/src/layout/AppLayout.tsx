import { useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
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
} from '@ant-design/icons';
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

const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'Overview', items: [{ key: '/', label: 'Dashboard', icon: <AppstoreOutlined />, module: 'dashboard' }] },
  {
    group: 'Mail automation',
    items: [
      { key: '/accounts', label: 'Email Accounts', icon: <MailOutlined />, module: 'accounts' },
      { key: '/rules', label: 'Download Rules', icon: <NodeIndexOutlined />, module: 'rules' },
      { key: '/rule-testing', label: 'Rule Testing', icon: <ExperimentOutlined />, module: 'ruleTesting' },
      { key: '/historical-jobs', label: 'Historical Jobs', icon: <HistoryOutlined />, module: 'ruleTesting' },
    ],
  },
  {
    group: 'Records',
    items: [
      { key: '/history', label: 'Download History', icon: <FileSearchOutlined />, module: 'history' },
      { key: '/destinations', label: 'Destination Folders', icon: <FolderOpenOutlined />, module: 'destinations' },
    ],
  },
  {
    group: 'Monitoring',
    items: [
      { key: '/notifications', label: 'Notifications', icon: <BellOutlined />, module: 'notifications' },
      { key: '/logs', label: 'Audit & Logs', icon: <ProfileOutlined />, module: 'logs' },
      { key: '/system', label: 'System Status', icon: <CloudServerOutlined />, module: 'dashboard' },
    ],
  },
  {
    group: 'Administration',
    items: [
      { key: '/users', label: 'Users & Roles', icon: <TeamOutlined />, module: 'users' },
      { key: '/settings', label: 'Settings', icon: <SettingOutlined />, module: 'settings' },
    ],
  },
];

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
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const status = useQuery({ queryKey: ['system-status'], queryFn: () => api.get<StatusResp>('/api/system/status'), refetchInterval: 30_000 });
  const notes = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<NotificationRow[]>('/api/notifications'), refetchInterval: 30_000 });
  const unread = notes.data?.filter((n) => !n.readAt).length ?? 0;
  const worker = status.data?.workers.find((w) => w.online) ?? status.data?.workers[0];

  const items: MenuProps['items'] = useMemo(
    () =>
      NAV.map((g) => ({
        type: 'group' as const,
        label: collapsed ? null : g.group,
        children: g.items.filter((i) => can(i.module)).map((i) => ({ key: i.key, icon: i.icon, label: i.label })),
      })).filter((g) => g.children.length > 0),
    [can, collapsed],
  );

  const selected = '/' + (pathname.split('/')[1] ?? '');

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
        <Menu mode="inline" selectedKeys={[selected]} items={items} onClick={(e) => navigate(e.key)} />
      </Sider>

      <Layout>
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
                  { key: 'logout', icon: <LogoutOutlined />, label: 'Sign out', danger: true },
                ],
                onClick: (e) => e.key === 'logout' && void logout(),
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <Avatar style={{ background: '#EEF2FF', color: '#4F46E5', fontWeight: 600 }}>
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
        </Content>
      </Layout>
    </Layout>
  );
}
