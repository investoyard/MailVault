import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Avatar, Button, Card, Checkbox, Drawer, Form, Input, Modal, Radio, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { CheckOutlined, EditOutlined, KeyOutlined, MinusOutlined, SafetyCertificateOutlined, UserAddOutlined } from '@ant-design/icons';
import { ACTIONS, MODULES, ROLE_TEMPLATES, ROLES, type Action, type Module, type PermissionSet, type Role } from '@mailvault/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { PageHeader } from '../components/ui';
import { fmtDateTime, fromNow } from '../format';

interface User {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  role: Role;
  permissions: PermissionSet | null;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  entraObjectId: string | null;
  mailboxIds: string[];
}

export const ROLE_META: Record<Role, { label: string; color: string; text: string }> = {
  SUPER_ADMIN: { label: 'Super Admin', color: 'purple', text: 'Everything, including users and settings. Sees all mailboxes.' },
  ADMIN: { label: 'Admin', color: 'blue', text: 'Manages accounts, rules and folders for the mailboxes assigned to them.' },
  OPERATOR: { label: 'Operator', color: 'cyan', text: 'Runs tests, historical jobs, manual downloads and retries.' },
  VIEWER: { label: 'Viewer', color: 'default', text: 'Read-only dashboards and history.' },
};

const MODULE_LABEL: Record<Module, string> = {
  dashboard: 'Dashboard',
  accounts: 'Email accounts',
  rules: 'Download rules',
  ruleTesting: 'Rule testing & historical jobs',
  history: 'Download history',
  destinations: 'Destination folders',
  notifications: 'Notifications',
  logs: 'Audit & logs',
  users: 'Users & roles',
  settings: 'Settings',
};

const ACTION_LABEL: Record<Action, string> = { view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete', execute: 'Run' };

function PermissionMatrix({ role, value, onChange, disabled }: { role: Role; value: PermissionSet; onChange: (v: PermissionSet) => void; disabled?: boolean }) {
  const template = ROLE_TEMPLATES[role];
  const toggle = (m: Module, a: Action, on: boolean) => {
    const cur = new Set(value[m] ?? []);
    if (on) cur.add(a);
    else cur.delete(a);
    if (on && a !== 'view') cur.add('view'); // any action implies seeing the module
    if (!on && a === 'view') cur.clear();
    onChange({ ...value, [m]: ACTIONS.filter((x) => cur.has(x)) });
  };
  return (
    <Table
      size="small"
      pagination={false}
      rowKey="m"
      dataSource={MODULES.map((m) => ({ m }))}
      columns={[
        { title: 'Module', dataIndex: 'm', render: (m: Module) => MODULE_LABEL[m] },
        ...ACTIONS.map((a) => ({
          title: ACTION_LABEL[a],
          key: a,
          align: 'center' as const,
          render: (_: unknown, { m }: { m: Module }) => {
            const on = (value[m] ?? []).includes(a);
            const changed = on !== (template[m] ?? []).includes(a);
            return (
              <Tooltip title={changed ? 'Different from the role default' : undefined}>
                <Checkbox checked={on} disabled={disabled} onChange={(e) => toggle(m, a, e.target.checked)} style={changed ? { outline: '2px solid #FDE68A', borderRadius: 4 } : undefined} />
              </Tooltip>
            );
          },
        })),
      ]}
    />
  );
}

function UserDrawer({ open, user, onClose }: { open: boolean; user: User | null; onClose: () => void }) {
  const { message } = App.useApp();
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const role = (Form.useWatch('role', form) as Role | undefined) ?? 'VIEWER';
  const [custom, setCustom] = useState(false);
  const [perms, setPerms] = useState<PermissionSet>({});
  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<{ id: string; email: string }[]>('/api/mailboxes') });

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (user) {
      form.setFieldsValue({ ...user, email: user.email ?? '' });
      setCustom(!!user.permissions);
      setPerms({ ...ROLE_TEMPLATES[user.role], ...(user.permissions ?? {}) });
    } else {
      form.setFieldsValue({ role: 'VIEWER', isActive: true, mailboxIds: [] });
      setCustom(false);
      setPerms(ROLE_TEMPLATES.VIEWER);
    }
  }, [open, user, form]);

  useEffect(() => {
    if (!custom) setPerms(ROLE_TEMPLATES[role]);
  }, [role, custom]);

  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => {
      const body = { ...v, permissions: custom && role !== 'SUPER_ADMIN' ? perms : null };
      return user ? api.put(`/api/users/${user.id}`, body) : api.post('/api/users', body);
    },
    onSuccess: () => {
      message.success(user ? 'User updated. Changes apply within a few seconds.' : 'User created. They will choose their own password at first sign-in.');
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const self = user?.id === me?.id;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={760}
      destroyOnHidden
      title={user ? `Edit user · ${user.displayName}` : 'Add user'}
      extra={
        <Space>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>
            {user ? 'Save changes' : 'Create user'}
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <Space size={16} style={{ display: 'flex' }} align="start">
          <Form.Item name="displayName" label="Full name" rules={[{ required: true, min: 2 }]} style={{ flex: 1, minWidth: 260 }}>
            <Input placeholder="Priya Sharma" />
          </Form.Item>
          <Form.Item name="email" label="Email (for alerts)" rules={[{ type: 'email' }]} style={{ flex: 1, minWidth: 260 }}>
            <Input placeholder="priya@company.com" />
          </Form.Item>
        </Space>
        {!user && (
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item name="username" label="Username" rules={[{ required: true, pattern: /^[a-z0-9._-]{3,40}$/i, message: '3–40 letters, numbers, dot, dash or underscore' }]} style={{ flex: 1, minWidth: 260 }}>
              <Input placeholder="priya.sharma" />
            </Form.Item>
            <Form.Item
              name="password"
              label="Temporary password"
              tooltip="They will be asked to change it at first sign-in."
              rules={[{ required: true, min: 10, message: 'At least 10 characters' }, { pattern: /(?=.*[a-zA-Z])(?=.*\d)/, message: 'Use letters and numbers' }]}
              style={{ flex: 1, minWidth: 260 }}
            >
              <Input.Password />
            </Form.Item>
          </Space>
        )}

        <Form.Item name="role" label="Role">
          <Radio.Group style={{ display: 'flex', flexDirection: 'column', gap: 8 }} disabled={self}>
            {ROLES.map((r) => (
              <Radio key={r} value={r} disabled={r === 'SUPER_ADMIN' && me?.role !== 'SUPER_ADMIN'}>
                <Tag color={ROLE_META[r].color}>{ROLE_META[r].label}</Tag>
                <span className="mv-muted" style={{ fontSize: 13 }}>{ROLE_META[r].text}</span>
              </Radio>
            ))}
          </Radio.Group>
        </Form.Item>
        {self && <Alert type="info" showIcon style={{ marginBottom: 16 }} message="You cannot change your own role or disable your own account." />}

        {role !== 'SUPER_ADMIN' && (
          <Form.Item name="mailboxIds" label="Email accounts this user can see" tooltip="Rules, history, tests and dashboard figures are limited to these mailboxes.">
            <Select mode="multiple" placeholder="No mailboxes yet" options={(mailboxes.data ?? []).map((m) => ({ value: m.id, label: m.email }))} />
          </Form.Item>
        )}

        {user && (
          <Form.Item name="isActive" label="Account active" valuePropName="checked">
            <Switch disabled={self} />
          </Form.Item>
        )}

        <Card size="small" className="mv-card" style={{ marginTop: 8 }} title={<Space><SafetyCertificateOutlined />Permissions</Space>} extra={role !== 'SUPER_ADMIN' && <Switch checked={custom} onChange={setCustom} checkedChildren="Custom" unCheckedChildren="Role default" />}>
          {role === 'SUPER_ADMIN' ? (
            <Typography.Text type="secondary">Super Admins always have every permission.</Typography.Text>
          ) : (
            <>
              {!custom && <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>Using the {ROLE_META[role].label} defaults. Switch to Custom to fine-tune.</Typography.Paragraph>}
              <PermissionMatrix role={role} value={perms} onChange={setPerms} disabled={!custom} />
            </>
          )}
        </Card>
      </Form>
    </Drawer>
  );
}

export function UsersPage() {
  const { can, user: me } = useAuth();
  const { message } = App.useApp();
  const [drawer, setDrawer] = useState<{ open: boolean; user: User | null }>({ open: false, user: null });
  const [resetFor, setResetFor] = useState<User | null>(null);
  const [newPw, setNewPw] = useState('');
  const q = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/api/users') });
  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<{ id: string; email: string }[]>('/api/mailboxes') });
  const mbName = useMemo(() => new Map((mailboxes.data ?? []).map((m) => [m.id, m.email])), [mailboxes.data]);

  const reset = useMutation({
    mutationFn: () => api.post<{ message: string }>(`/api/users/${resetFor!.id}/reset-password`, { password: newPw }),
    onSuccess: (r) => {
      message.success(r.message);
      setResetFor(null);
      setNewPw('');
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="Users & Roles"
        subtitle="Who can sign in, what they can do, and which email accounts they can see."
        extra={
          can('users', 'create') && (
            <Button type="primary" icon={<UserAddOutlined />} onClick={() => setDrawer({ open: true, user: null })}>
              Add user
            </Button>
          )
        }
      />

      <Card className="mv-card" styles={{ body: { padding: 0 } }} style={{ marginBottom: 16 }}>
        <Table
          rowKey="id"
          loading={q.isLoading}
          dataSource={q.data ?? []}
          pagination={false}
          rowClassName={(u) => (u.isActive ? '' : 'mv-row-muted')}
          columns={[
            {
              title: 'User',
              render: (_, u) => (
                <Space size={12}>
                  <Avatar style={{ background: u.isActive ? '#EFECF8' : '#F1F5F9', color: u.isActive ? '#3C2E7E' : '#94A3B8', fontWeight: 600 }}>{u.displayName[0]?.toUpperCase()}</Avatar>
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {u.displayName} {u.id === me?.id && <Tag style={{ marginLeft: 4 }}>You</Tag>}
                    </div>
                    <div className="mv-muted" style={{ fontSize: 12.5 }}>{u.email ?? u.username}</div>
                  </div>
                </Space>
              ),
            },
            {
              title: 'Role',
              render: (_, u) => (
                <Space size={4}>
                  <Tag color={ROLE_META[u.role].color}>{ROLE_META[u.role].label}</Tag>
                  {u.permissions && <Tooltip title="Permissions customised for this user"><Tag>Custom</Tag></Tooltip>}
                </Space>
              ),
            },
            {
              title: 'Email accounts',
              render: (_, u) =>
                u.role === 'SUPER_ADMIN' ? (
                  <span className="mv-muted">All</span>
                ) : u.mailboxIds.length ? (
                  <Tooltip title={u.mailboxIds.map((id) => mbName.get(id) ?? id).join(', ')}>
                    <span>{u.mailboxIds.length} assigned</span>
                  </Tooltip>
                ) : (
                  <Tag color="orange">None assigned</Tag>
                ),
            },
            { title: 'Sign-in', responsive: ['lg'], render: (_, u) => <Tag>{u.entraObjectId ? 'Microsoft' : 'Local'}</Tag> },
            { title: 'Last sign-in', render: (_, u) => <Tooltip title={fmtDateTime(u.lastLoginAt)}><span className="mv-muted">{fromNow(u.lastLoginAt)}</span></Tooltip> },
            {
              title: 'Status',
              render: (_, u) => (
                <Space size={4}>
                  {u.isActive ? <Tag color="green">Active</Tag> : <Tag>Disabled</Tag>}
                  {u.mustChangePassword && u.isActive && <Tooltip title="Must choose a new password at next sign-in"><Tag color="gold">New password due</Tag></Tooltip>}
                </Space>
              ),
            },
            {
              title: '',
              align: 'right',
              render: (_, u) =>
                can('users', 'edit') && (
                  <Space>
                    <Button icon={<EditOutlined />} onClick={() => setDrawer({ open: true, user: u })}>Edit</Button>
                    <Tooltip title="Reset password"><Button icon={<KeyOutlined />} onClick={() => setResetFor(u)} disabled={!!u.entraObjectId} /></Tooltip>
                  </Space>
                ),
            },
          ]}
        />
      </Card>

      <Card className="mv-card" title="Role defaults" styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="module"
          size="small"
          pagination={false}
          scroll={{ x: 900 }}
          dataSource={MODULES.map((m) => ({ module: m }))}
          columns={[
            { title: 'Module', dataIndex: 'module', fixed: 'left', width: 220, render: (m: Module) => <b>{MODULE_LABEL[m]}</b> },
            ...ROLES.map((role) => ({
              title: <Tooltip title={ROLE_META[role].text}><span>{ROLE_META[role].label}</span></Tooltip>,
              key: role,
              render: (_: unknown, row: { module: Module }) => {
                const acts = ROLE_TEMPLATES[role][row.module] ?? [];
                if (!acts.length) return <MinusOutlined style={{ color: '#CBD5E1' }} />;
                if (acts.length === ACTIONS.length) return <Tag color="green" icon={<CheckOutlined />}>Full</Tag>;
                return <span className="mv-muted" style={{ fontSize: 12.5 }}>{acts.map((a) => ACTION_LABEL[a]).join(', ')}</span>;
              },
            })),
          ]}
        />
      </Card>

      <UserDrawer open={drawer.open} user={drawer.user} onClose={() => setDrawer({ open: false, user: null })} />

      <Modal
        open={!!resetFor}
        title={`Reset password · ${resetFor?.displayName ?? ''}`}
        okText="Reset password"
        onOk={() => reset.mutate()}
        okButtonProps={{ disabled: newPw.length < 10 || !/[a-zA-Z]/.test(newPw) || !/\d/.test(newPw), loading: reset.isPending }}
        onCancel={() => setResetFor(null)}
        destroyOnHidden
      >
        <p className="mv-muted">Give this temporary password to the person securely. They must choose a new one when they sign in.</p>
        <Input.Password value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="At least 10 characters, letters and numbers" />
      </Modal>
    </>
  );
}
