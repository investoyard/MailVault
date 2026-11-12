import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Alert, Button, Card, DatePicker, Descriptions, Drawer, Dropdown, Form, Input, InputNumber, Modal, Radio, Space, Switch, Table, Tag, Tooltip } from 'antd';
import { ApiOutlined, CheckCircleFilled, CloseCircleFilled, FolderOutlined, MailOutlined, MoreOutlined, PlusOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import { FoldersModal } from '../components/FoldersModal';
import dayjs, { type Dayjs } from 'dayjs';
import type { MailboxAuthMode, MailboxStatus } from '@mailvault/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { EmptyState, MailboxStatusTag, PageHeader } from '../components/ui';
import { useConfirm } from '../components/confirm';
import { fmtDateTime, fmtNumber, fromNow } from '../format';

interface Mailbox {
  id: string;
  email: string;
  displayName: string | null;
  authMode: MailboxAuthMode;
  status: MailboxStatus;
  enabled: boolean;
  syncIntervalMinutes: number | null;
  monitoringStartAt: string;
  lastSyncAt: string | null;
  lastError: string | null;
  folders: { displayName: string }[];
  _count: { rules: number; messages: number };
}

interface TestResult {
  ok: boolean;
  latencyMs: number;
  mailbox: string;
  folderCount?: number;
  sampleMessageSubject?: string;
  error?: string;
}

export function AccountsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [form] = Form.useForm();

  const q = useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<Mailbox[]>('/api/mailboxes') });

  const create = useMutation({
    mutationFn: (v: { email: string; displayName?: string; authMode: MailboxAuthMode; syncIntervalMinutes?: number; monitoringStartAt?: Dayjs }) =>
      api.post('/api/mailboxes', { ...v, monitoringStartAt: v.monitoringStartAt?.toISOString() }),
    onSuccess: () => {
      message.success('Email account added. Run "Test connection" to verify access.');
      setOpen(false);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['mailboxes'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/api/mailboxes/${id}`, { enabled }),
    onSuccess: (_d, v) => {
      message.success(v.enabled ? 'Monitoring enabled' : 'Monitoring paused');
      void qc.invalidateQueries({ queryKey: ['mailboxes'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const [foldersFor, setFoldersFor] = useState<Mailbox | null>(null);

  const sync = useMutation({
    mutationFn: (id: string) => api.post<{ message: string }>(`/api/mailboxes/${id}/sync`),
    onSuccess: (r) => {
      message.success(r.message);
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['mailboxes'] }), 4000);
    },
    onError: (e: Error) => message.error(e.message),
  });

  const runTest = async (m: Mailbox) => {
    setTesting(m.id);
    try {
      setTestResult(await api.post<TestResult>(`/api/mailboxes/${m.id}/test`));
      void qc.invalidateQueries({ queryKey: ['mailboxes'] });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setTesting(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Email Accounts"
        subtitle="Microsoft 365 mailboxes that MailVault monitors (read-only access)."
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => q.refetch()} loading={q.isFetching}>
              Refresh
            </Button>
            {can('accounts', 'create') && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
                Add email account
              </Button>
            )}
          </>
        }
      />

      <Card className="mv-card" styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          loading={q.isLoading}
          dataSource={q.data ?? []}
          pagination={false}
          locale={{
            emptyText: (
              <EmptyState
                title="No email accounts yet"
                description="Add a Microsoft 365 mailbox to start monitoring it for attachments."
                action={can('accounts', 'create') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>Add email account</Button>}
              />
            ),
          }}
          columns={[
            {
              title: 'Mailbox',
              render: (_, m) => (
                <Space size={12}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: '#EFECF8', color: '#3C2E7E', display: 'grid', placeItems: 'center' }}>
                    <MailOutlined />
                  </div>
                  <div>
                    <div style={{ fontWeight: 600 }}>{m.email}</div>
                    <div className="mv-muted" style={{ fontSize: 12.5 }}>
                      {m.displayName ? `${m.displayName} · ` : ''}
                      {fmtNumber(m._count.rules)} rule{m._count.rules === 1 ? '' : 's'}
                    </div>
                  </div>
                </Space>
              ),
            },
            { title: 'Status', dataIndex: 'status', render: (s: MailboxStatus, m) => <MailboxStatusTag status={s} error={m.lastError} /> },
            {
              title: 'Access',
              dataIndex: 'authMode',
              responsive: ['xxl'],
              render: (a: MailboxAuthMode) => <Tag>{a === 'APP_ONLY' ? 'App-only' : 'User sign-in'}</Tag>,
            },
            { title: 'Folders', responsive: ['xxl'], render: (_, m) => m.folders.map((f) => f.displayName).join(', ') || '—' },
            {
              title: 'Last sync',
              dataIndex: 'lastSyncAt',
              responsive: ['lg'],
              onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
              render: (v: string | null) => <Tooltip title={fmtDateTime(v)}><span className="mv-muted" style={{ whiteSpace: 'nowrap' }}>{fromNow(v)}</span></Tooltip>,
            },
            {
              title: 'Monitoring',
              align: 'center',
              render: (_, m) => (
                <Switch
                  checked={m.enabled}
                  disabled={!can('accounts', 'edit')}
                  loading={toggle.isPending && toggle.variables?.id === m.id}
                  onChange={(enabled) =>
                    void confirm(
                      enabled
                        ? {
                            tone: 'success',
                            title: 'Resume monitoring?',
                            subject: m.email,
                            description: 'MailVault will start checking this mailbox for new emails again.',
                            okText: 'Resume monitoring',
                            onConfirm: () => toggle.mutateAsync({ id: m.id, enabled }),
                          }
                        : {
                            tone: 'warning',
                            title: 'Pause monitoring?',
                            subject: m.email,
                            description: 'New emails in this mailbox will not be processed until you resume. Nothing already saved is affected.',
                            okText: 'Pause monitoring',
                            onConfirm: () => toggle.mutateAsync({ id: m.id, enabled }),
                          },
                    )
                  }
                />
              ),
            },
            {
              title: '',
              align: 'right',
              render: (_, m) => (
                <Space size={8}>
                  {can('accounts', 'execute') && (
                    <Button icon={<SyncOutlined />} loading={sync.isPending && sync.variables === m.id} disabled={!m.enabled} onClick={() => sync.mutate(m.id)}>
                      Sync now
                    </Button>
                  )}
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: [
                        { key: 'test', icon: <ApiOutlined />, label: 'Test connection', disabled: !can('accounts', 'execute') },
                        { key: 'folders', icon: <FolderOutlined />, label: 'Monitored folders' },
                      ],
                      onClick: (e) => (e.key === 'test' ? void runTest(m) : setFoldersFor(m)),
                    }}
                  >
                    <Button icon={<MoreOutlined />} loading={testing === m.id} aria-label="More actions" />
                  </Dropdown>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        title="Add email account"
        width={520}
        open={open}
        onClose={() => setOpen(false)}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="primary" loading={create.isPending} onClick={() => form.submit()}>
              Add account
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 20 }}
          message="Read-only by design"
          description="MailVault only needs Mail.Read. It can never delete, move or change emails."
        />
        <Form form={form} layout="vertical" requiredMark="optional" initialValues={{ authMode: 'APP_ONLY' }} onFinish={(v) => create.mutate(v)}>
          <Form.Item name="email" label="Mailbox address" rules={[{ required: true, type: 'email', message: 'Enter a valid email address' }]}>
            <Input placeholder="accounts@company.com" prefix={<MailOutlined className="mv-muted" />} />
          </Form.Item>
          <Form.Item name="displayName" label="Display name">
            <Input placeholder="Accounts team" />
          </Form.Item>
          <Form.Item name="authMode" label="Access method">
            <Radio.Group style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Radio value="APP_ONLY">
                <b>App-only (recommended)</b>
                <div className="mv-muted" style={{ fontSize: 12.5 }}>Uses the organisation's MailVault app. No password expiry issues.</div>
              </Radio>
              <Radio value="DELEGATED" disabled>
                <b>User sign-in</b>
                <div className="mv-muted" style={{ fontSize: 12.5 }}>The mailbox owner signs in once. Available in Phase 1.</div>
              </Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="syncIntervalMinutes" label="Sync every (minutes)" tooltip="Leave empty to use the global setting.">
            <InputNumber min={1} max={1440} style={{ width: '100%' }} placeholder="Global default (5)" />
          </Form.Item>
          <Form.Item
            name="monitoringStartAt"
            label="Process emails received after"
            tooltip="Older emails are only processed by an explicit historical job, so connecting a mailbox never downloads years of old mail."
          >
            <DatePicker showTime style={{ width: '100%' }} placeholder="Now (default)" disabledDate={(d) => d.isAfter(dayjs())} />
          </Form.Item>
        </Form>
      </Drawer>

      <FoldersModal mailbox={foldersFor} canEdit={can('accounts', 'edit')} onClose={() => setFoldersFor(null)} />

      <Modal open={!!testResult} onCancel={() => setTestResult(null)} footer={<Button type="primary" onClick={() => setTestResult(null)}>Close</Button>} title="Connection test">
        {testResult && (
          <>
            <Alert
              type={testResult.ok ? 'success' : 'error'}
              showIcon
              icon={testResult.ok ? <CheckCircleFilled /> : <CloseCircleFilled />}
              message={testResult.ok ? `Connected to ${testResult.mailbox}` : 'Connection failed'}
              description={testResult.error}
              style={{ marginBottom: 16 }}
            />
            {testResult.ok && (
              <Descriptions column={1} size="small" bordered>
                <Descriptions.Item label="Response time">{testResult.latencyMs} ms</Descriptions.Item>
                <Descriptions.Item label="Mail folders">{testResult.folderCount}</Descriptions.Item>
                <Descriptions.Item label="Newest Inbox email">{testResult.sampleMessageSubject}</Descriptions.Item>
              </Descriptions>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
