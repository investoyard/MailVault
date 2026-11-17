import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Checkbox, Drawer, Form, Input, Modal, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { ApiOutlined, CopyOutlined, DeleteOutlined, EditOutlined, KeyOutlined, PlusOutlined, RedoOutlined, SendOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { api } from '../api';
import { useAuth } from '../auth';
import { EmptyState, PageHeader } from '../components/ui';
import { useConfirm } from '../components/confirm';
import { fmtDateTime, fromNow } from '../format';

interface Hook {
  id: string;
  name: string;
  url: string;
  events: string[];
  mailboxIds: string[];
  ruleIds: string[];
  enabled: boolean;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveredAt: string | null;
  last24h: { success: number; failed: number; pending: number };
}

interface Delivery {
  id: string;
  event: string;
  status: string;
  attempts: number;
  responseCode: number | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
  payload: unknown;
}

const EVENTS = [
  { value: 'file.saved', label: 'File saved', text: 'An attachment (or a file unpacked from a ZIP / attached email) was saved to a folder' },
  { value: 'file.failed', label: 'File failed', text: 'A download failed permanently after all retries' },
  { value: 'job.completed', label: 'Historical job finished', text: 'A historical job (simulate or execute) completed' },
];

type ActionResult = { ok?: boolean; message?: string; secret?: string };

const STATUS_COLOR: Record<string, string> = { SUCCESS: 'green', FAILED: 'red', RETRYING: 'orange', PENDING: 'blue', SENDING: 'processing' };

function SecretModal({ secret, onClose }: { secret: string | null; onClose: () => void }) {
  const { message } = App.useApp();
  return (
    <Modal open={!!secret} title="Signing secret" onCancel={onClose} footer={<Button type="primary" onClick={onClose}>I have saved it</Button>} maskClosable={false} closable={false}>
      <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Copy this now. It is shown only once." description="Give it to the team that runs the receiving system, so they can check that requests really come from MailVault." />
      <Space.Compact style={{ width: '100%' }}>
        <Input value={secret ?? ''} readOnly className="mv-mono" />
        <Button icon={<CopyOutlined />} onClick={() => { void navigator.clipboard.writeText(secret ?? ''); message.success('Copied'); }}>
          Copy
        </Button>
      </Space.Compact>
    </Modal>
  );
}

function HookDrawer({ open, hook, onClose, onCreated }: { open: boolean; hook: Hook | null; onClose: () => void; onCreated: (secret: string) => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<{ id: string; email: string }[]>('/api/mailboxes') });
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api.get<{ id: string; name: string; mailbox: { email: string } }[]>('/api/rules') });

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(hook ?? { events: ['file.saved'], enabled: true, mailboxIds: [], ruleIds: [] });
  }, [open, hook, form]);

  const save = useMutation({
    mutationFn: (v: object) => (hook ? api.put(`/api/webhooks/${hook.id}`, v) : api.post<{ secret: string }>('/api/webhooks', v)),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['webhooks'] });
      onClose();
      if (!hook && r && typeof r === 'object' && 'secret' in r) onCreated((r as { secret: string }).secret);
      else message.success('Integration saved');
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={620}
      destroyOnHidden
      title={hook ? `Edit integration · ${hook.name}` : 'Add integration (webhook)'}
      extra={
        <Space>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>
            {hook ? 'Save' : 'Create'}
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <Form.Item name="name" label="Name" rules={[{ required: true, min: 2 }]}>
          <Input placeholder="SAP – invoice inbox" />
        </Form.Item>
        <Form.Item name="url" label="Receiver URL" rules={[{ required: true, type: 'url', message: 'Enter an http(s) address' }]} extra="MailVault sends an HTTP POST with JSON to this address. Prefer https.">
          <Input className="mv-mono" placeholder="https://erp.company.local/api/mailvault" />
        </Form.Item>
        <Form.Item name="events" label="Send these events" rules={[{ required: true, type: 'array', min: 1, message: 'Choose at least one event' }]}>
          <Checkbox.Group style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {EVENTS.map((e) => (
              <Checkbox key={e.value} value={e.value}>
                <b>{e.label}</b> <span className="mv-mono mv-muted" style={{ fontSize: 12 }}>{e.value}</span>
                <div className="mv-muted" style={{ fontSize: 12.5 }}>{e.text}</div>
              </Checkbox>
            ))}
          </Checkbox.Group>
        </Form.Item>
        <Form.Item name="mailboxIds" label="Only for these email accounts" tooltip="Leave empty for all.">
          <Select mode="multiple" placeholder="All email accounts" options={(mailboxes.data ?? []).map((m) => ({ value: m.id, label: m.email }))} />
        </Form.Item>
        <Form.Item name="ruleIds" label="Only for these rules" tooltip="Leave empty for all.">
          <Select mode="multiple" placeholder="All rules" options={(rules.data ?? []).map((r) => ({ value: r.id, label: `${r.name} · ${r.mailbox.email}` }))} />
        </Form.Item>
        <Form.Item name="enabled" label="Active" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Drawer>
  );
}

function DeliveriesDrawer({ hook, onClose }: { hook: Hook | null; onClose: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['webhook-deliveries', hook?.id], queryFn: () => api.get<Delivery[]>(`/api/webhooks/${hook!.id}/deliveries`), enabled: !!hook, refetchInterval: 5000 });
  const redeliver = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean; message: string }>(`/api/webhook-deliveries/${id}/redeliver`),
    onSuccess: (r) => {
      (r.ok ? message.success : message.warning)(r.message);
      void qc.invalidateQueries({ queryKey: ['webhook-deliveries', hook?.id] });
    },
  });
  return (
    <Drawer open={!!hook} onClose={onClose} width={860} title={`Deliveries · ${hook?.name ?? ''}`} destroyOnHidden>
      <Table
        rowKey="id"
        size="small"
        loading={q.isLoading}
        dataSource={q.data ?? []}
        pagination={{ pageSize: 20, size: 'small' }}
        expandable={{ expandedRowRender: (d) => <pre className="mv-mono" style={{ margin: 0, whiteSpace: 'pre-wrap', background: '#F8FAFC', padding: 12, borderRadius: 8 }}>{JSON.stringify(d.payload, null, 2)}</pre> }}
        columns={[
          { title: 'When', dataIndex: 'createdAt', width: 160, render: fmtDateTime },
          { title: 'Event', dataIndex: 'event', render: (e: string) => <span className="mv-mono">{e}</span> },
          { title: 'Status', render: (_, d) => <Tag color={STATUS_COLOR[d.status]}>{d.status}</Tag> },
          { title: 'Tries', dataIndex: 'attempts', width: 60, align: 'center' },
          { title: 'Answer', render: (_, d) => (d.error ? <Tooltip title={d.error}><span className="mv-muted">{d.responseCode ?? 'no answer'}</span></Tooltip> : <span className="mv-muted">{d.responseCode ?? '—'}</span>) },
          { title: 'Next try', render: (_, d) => (d.nextAttemptAt ? <span className="mv-muted">{fromNow(d.nextAttemptAt)}</span> : '—') },
          { title: '', width: 50, render: (_, d) => d.status !== 'SUCCESS' && <Tooltip title="Send again now"><Button size="small" icon={<RedoOutlined />} loading={redeliver.isPending && redeliver.variables === d.id} onClick={() => redeliver.mutate(d.id)} /></Tooltip> },
        ]}
      />
    </Drawer>
  );
}

export function IntegrationsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [drawer, setDrawer] = useState<{ open: boolean; hook: Hook | null }>({ open: false, hook: null });
  const [secret, setSecret] = useState<string | null>(null);
  const [log, setLog] = useState<Hook | null>(null);
  const q = useQuery({ queryKey: ['webhooks'], queryFn: () => api.get<Hook[]>('/api/webhooks'), refetchInterval: 15_000 });
  const edit = can('integrations', 'edit');

  const action = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: 'test' | 'rotate' | 'delete' }): Promise<ActionResult> =>
      kind === 'delete' ? api.del<ActionResult>(`/api/webhooks/${id}`) : api.post<ActionResult>(`/api/webhooks/${id}/${kind === 'test' ? 'test' : 'rotate-secret'}`),
    onSuccess: (res, v) => {
      if (v.kind === 'rotate' && res.secret) setSecret(res.secret);
      else if (v.kind === 'test') (res.ok ? message.success : message.error)(res.message ?? '');
      else message.success('Integration removed');
      void qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="Tell other systems (ERP, document management, scripts) the moment MailVault saves a file. Each request is signed so the receiver can trust it."
        extra={edit && <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawer({ open: true, hook: null })}>Add integration</Button>}
      />

      <Card className="mv-card" styles={{ body: { padding: 0 } }} style={{ marginBottom: 16 }}>
        <Table
          rowKey="id"
          loading={q.isLoading}
          dataSource={q.data ?? []}
          pagination={false}
          locale={{
            emptyText: (
              <EmptyState
                title="No integrations yet"
                description="Add a webhook to send a JSON message to another system whenever a file is saved or fails."
                action={edit && <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawer({ open: true, hook: null })}>Add integration</Button>}
              />
            ),
          }}
          columns={[
            {
              title: 'Integration',
              render: (_, h) => (
                <Space size={12}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: '#EFECF8', color: '#3C2E7E', display: 'grid', placeItems: 'center' }}>
                    <ApiOutlined />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {h.name} {!h.enabled && <Tag>Paused</Tag>}
                    </div>
                    <Typography.Text className="mv-mono mv-muted" ellipsis={{ tooltip: h.url }} style={{ maxWidth: 'min(380px, 26vw)', display: 'block' }}>{h.url}</Typography.Text>
                  </div>
                </Space>
              ),
            },
            { title: 'Events', render: (_, h) => h.events.map((e) => <Tag key={e} className="mv-mono">{e}</Tag>) },
            { title: 'Scope', responsive: ['xxl'], render: (_, h) => <span className="mv-muted">{h.mailboxIds.length ? `${h.mailboxIds.length} mailbox(es)` : 'All mailboxes'}{h.ruleIds.length ? ` · ${h.ruleIds.length} rule(s)` : ''}</span> },
            {
              title: 'Last 24 h',
              render: (_, h) => (
                <Space size={4}>
                  <Tag color="green">{h.last24h.success} sent</Tag>
                  {h.last24h.pending > 0 && <Tag color="orange">{h.last24h.pending} waiting</Tag>}
                  {h.last24h.failed > 0 && <Tag color="red">{h.last24h.failed} failed</Tag>}
                </Space>
              ),
            },
            {
              title: 'Last answer',
              render: (_, h) =>
                h.lastStatus || h.lastError ? (
                  <Tooltip title={h.lastError ?? `Delivered ${fmtDateTime(h.lastDeliveredAt)}`}>
                    <Tag color={h.lastError ? 'red' : 'green'}>{h.lastStatus ?? 'no answer'}</Tag>
                  </Tooltip>
                ) : (
                  <span className="mv-muted">never sent</span>
                ),
            },
            {
              title: '',
              align: 'right',
              render: (_, h) => (
                <Space>
                  <Tooltip title="Delivery log"><Button icon={<UnorderedListOutlined />} onClick={() => setLog(h)} /></Tooltip>
                  {can('integrations', 'execute') && <Tooltip title="Send a test message"><Button icon={<SendOutlined />} loading={action.isPending && action.variables?.id === h.id && action.variables.kind === 'test'} onClick={() => action.mutate({ id: h.id, kind: 'test' })} /></Tooltip>}
                  {edit && (
                    <>
                      <Tooltip title="Edit"><Button icon={<EditOutlined />} onClick={() => setDrawer({ open: true, hook: h })} /></Tooltip>
                      <Tooltip title="New signing secret">
                        <Button
                          icon={<KeyOutlined />}
                          onClick={() =>
                            void confirm({
                              tone: 'warning',
                              icon: <KeyOutlined />,
                              title: 'Create a new signing secret?',
                              subject: h.name,
                              description: 'The current secret stops working immediately. The receiving system must be updated with the new secret.',
                              okText: 'Create new secret',
                              onConfirm: () => action.mutateAsync({ id: h.id, kind: 'rotate' }),
                            })
                          }
                        />
                      </Tooltip>
                      <Tooltip title="Remove">
                        <Button
                          danger
                          icon={<DeleteOutlined />}
                          onClick={() =>
                            void confirm({
                              tone: 'danger',
                              icon: <DeleteOutlined />,
                              title: 'Remove this integration?',
                              subject: h.name,
                              description: 'MailVault will stop sending events to it, and its delivery log is removed too. This cannot be undone.',
                              okText: 'Remove',
                              onConfirm: () => action.mutateAsync({ id: h.id, kind: 'delete' }),
                            })
                          }
                        />
                      </Tooltip>
                    </>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card className="mv-card" title="For the team building the receiver">
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          MailVault sends <span className="mv-mono">POST</span> with a JSON body and these headers: <span className="mv-mono">X-MailVault-Event</span>, <span className="mv-mono">X-MailVault-Delivery</span>,{' '}
          <span className="mv-mono">X-MailVault-Timestamp</span>, <span className="mv-mono">X-MailVault-Signature</span>. Answer with any 2xx status within 10 seconds; otherwise MailVault retries after 1, 5, 15, 60 and 240 minutes.
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Verify: <span className="mv-mono">sha256=HMAC_SHA256(secret, timestamp + "." + body)</span> must equal the signature header. Full example in docs/WEBHOOKS.md.
        </Typography.Paragraph>
      </Card>

      <HookDrawer open={drawer.open} hook={drawer.hook} onClose={() => setDrawer({ open: false, hook: null })} onCreated={setSecret} />
      <DeliveriesDrawer hook={log} onClose={() => setLog(null)} />
      <SecretModal secret={secret} onClose={() => setSecret(null)} />
    </>
  );
}
