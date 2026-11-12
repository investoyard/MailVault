import { useQuery } from '@tanstack/react-query';
import { Avatar, Button, Card, Space, Table, Tag, Tooltip } from 'antd';
import { CheckOutlined, MinusOutlined, UserAddOutlined } from '@ant-design/icons';
import { ACTIONS, MODULES, ROLE_TEMPLATES, ROLES, type Role } from '@mailvault/shared';
import { api } from '../api';
import { PageHeader } from '../components/ui';
import { fmtDateTime, fromNow } from '../format';

interface User {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  entraObjectId: string | null;
  _count: { mailboxAccess: number };
}

const ROLE_META: Record<Role, { label: string; color: string; text: string }> = {
  SUPER_ADMIN: { label: 'Super Admin', color: 'purple', text: 'Everything, including users and settings' },
  ADMIN: { label: 'Admin', color: 'blue', text: 'Accounts, rules and folders for assigned mailboxes' },
  OPERATOR: { label: 'Operator', color: 'cyan', text: 'Run tests, manual downloads and retries' },
  VIEWER: { label: 'Viewer', color: 'default', text: 'Read-only dashboards and history' },
};

const MODULE_LABEL: Record<string, string> = {
  dashboard: 'Dashboard',
  accounts: 'Email accounts',
  rules: 'Download rules',
  ruleTesting: 'Rule testing',
  history: 'History',
  destinations: 'Folders',
  notifications: 'Notifications',
  logs: 'Logs',
  users: 'Users',
  settings: 'Settings',
};

export function UsersPage() {
  const q = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/api/users') });

  return (
    <>
      <PageHeader
        title="Users & Roles"
        subtitle="Who can sign in and what they can do. Access to email accounts can be limited per user."
        extra={
          <Tooltip title="User invitations and Microsoft sign-in arrive in Phase 3">
            <Button type="primary" icon={<UserAddOutlined />} disabled>
              Add user
            </Button>
          </Tooltip>
        }
      />

      <Card className="mv-card" styles={{ body: { padding: 0 } }} style={{ marginBottom: 16 }}>
        <Table
          rowKey="id"
          loading={q.isLoading}
          dataSource={q.data ?? []}
          pagination={false}
          columns={[
            {
              title: 'User',
              render: (_, u) => (
                <Space size={12}>
                  <Avatar style={{ background: '#EEF2FF', color: '#4F46E5', fontWeight: 600 }}>{u.displayName[0]?.toUpperCase()}</Avatar>
                  <div>
                    <div style={{ fontWeight: 600 }}>{u.displayName}</div>
                    <div className="mv-muted" style={{ fontSize: 12.5 }}>{u.email ?? u.username}</div>
                  </div>
                </Space>
              ),
            },
            { title: 'Role', dataIndex: 'role', render: (r: Role) => <Tag color={ROLE_META[r].color}>{ROLE_META[r].label}</Tag> },
            { title: 'Sign-in', render: (_, u) => <Tag>{u.entraObjectId ? 'Microsoft' : 'Local'}</Tag> },
            { title: 'Mailbox access', render: (_, u) => (u.role === 'SUPER_ADMIN' ? 'All mailboxes' : `${u._count.mailboxAccess} assigned`) },
            { title: 'Last sign-in', render: (_, u) => <Tooltip title={fmtDateTime(u.lastLoginAt)}><span className="mv-muted">{fromNow(u.lastLoginAt)}</span></Tooltip> },
            { title: 'Status', render: (_, u) => (u.isActive ? <Tag color="green">Active</Tag> : <Tag>Disabled</Tag>) },
          ]}
        />
      </Card>

      <Card className="mv-card" title="Role permissions" styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="module"
          size="small"
          pagination={false}
          scroll={{ x: 900 }}
          dataSource={MODULES.map((m) => ({ module: m }))}
          columns={[
            { title: 'Module', dataIndex: 'module', fixed: 'left', width: 160, render: (m: string) => <b>{MODULE_LABEL[m]}</b> },
            ...ROLES.map((role) => ({
              title: (
                <Tooltip title={ROLE_META[role].text}>
                  <span>{ROLE_META[role].label}</span>
                </Tooltip>
              ),
              key: role,
              render: (_: unknown, row: { module: (typeof MODULES)[number] }) => {
                const acts = ROLE_TEMPLATES[role][row.module] ?? [];
                if (!acts.length) return <MinusOutlined style={{ color: '#CBD5E1' }} />;
                if (acts.length === ACTIONS.length) return <Tag color="green" icon={<CheckOutlined />}>Full</Tag>;
                return <span className="mv-muted" style={{ fontSize: 12.5 }}>{acts.join(', ')}</span>;
              },
            })),
          ]}
        />
      </Card>
    </>
  );
}
