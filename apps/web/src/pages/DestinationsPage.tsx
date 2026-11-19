import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Drawer, Form, Input, InputNumber, Space, Switch, Table, Tooltip, Typography } from 'antd';
import { CopyOutlined, FolderOpenOutlined, PlusOutlined, SafetyCertificateOutlined, SyncOutlined } from '@ant-design/icons';
import type { DestinationStatus } from '@mailvault/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { DestinationStatusTag, EmptyState, PageHeader } from '../components/ui';
import { CheckedAs, FolderPicker, type FolderOpReply } from '../components/FolderPicker';
import { fmtBytes, fmtDateTime, fromNow } from '../format';

interface Destination {
  id: string;
  name: string;
  basePath: string;
  status: DestinationStatus;
  freeSpaceMb: number | null;
  lowSpaceThresholdMb: number;
  createIfMissing: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  _count: { rules: number };
}

export function DestinationsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const [picking, setPicking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<FolderOpReply | null>(null);

  /** Runs the same write test the worker uses, before the folder is saved. */
  const runTest = async (path?: string) => {
    const basePath = (path ?? form.getFieldValue('basePath') ?? '').trim();
    if (!basePath) return void message.warning('Choose or type a folder first');
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(
        await api.post<FolderOpReply>('/api/destinations/test', {
          basePath,
          createIfMissing: form.getFieldValue('createIfMissing') ?? true,
          lowSpaceThresholdMb: form.getFieldValue('lowSpaceThresholdMb') ?? 1024,
        }),
      );
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const q = useQuery({ queryKey: ['destinations'], queryFn: () => api.get<Destination[]>('/api/destinations') });

  const create = useMutation({
    mutationFn: (v: object) => api.post<Destination>('/api/destinations', v),
    onSuccess: (d) => {
      if (d.status === 'UNAVAILABLE') message.warning(`Saved, but the folder is not accessible: ${d.lastError}`);
      else message.success('Destination folder added and verified');
      setOpen(false);
      form.resetFields();
      setTestResult(null);
      void qc.invalidateQueries({ queryKey: ['destinations'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const check = useMutation({
    mutationFn: (id: string) => api.post<Destination>(`/api/destinations/${id}/check`),
    onSuccess: (d) => {
      if (d.status === 'UNAVAILABLE') message.error(`${d.name}: ${d.lastError}`);
      else message.success(`${d.name} is accessible`);
      void qc.invalidateQueries({ queryKey: ['destinations'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="Destination Folders"
        subtitle="Reusable folders that rules save attachments into. Checked automatically every 5 minutes."
        extra={
          can('destinations', 'create') && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
              Add folder
            </Button>
          )
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
                title="No destination folders yet"
                description="Add a local folder (D:\...) or network share (\\server\share) where attachments will be saved."
                action={can('destinations', 'create') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>Add folder</Button>}
              />
            ),
          }}
          columns={[
            {
              title: 'Folder',
              render: (_, d) => (
                <Space size={12}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: '#FFFBEB', color: '#D97706', display: 'grid', placeItems: 'center' }}>
                    <FolderOpenOutlined />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{d.name}</div>
                    <Typography.Text className="mv-mono mv-muted" copyable={{ text: d.basePath, icon: <CopyOutlined /> }}>
                      {d.basePath}
                    </Typography.Text>
                  </div>
                </Space>
              ),
            },
            { title: 'Status', render: (_, d) => <DestinationStatusTag status={d.status} error={d.lastError} /> },
            { title: 'Free space', align: 'right', render: (_, d) => (d.freeSpaceMb !== null ? fmtBytes(d.freeSpaceMb * 1024 * 1024) : '—') },
            { title: 'Rules', align: 'right', render: (_, d) => d._count.rules },
            { title: 'Last checked', render: (_, d) => <Tooltip title={fmtDateTime(d.lastCheckedAt)}><span className="mv-muted">{fromNow(d.lastCheckedAt)}</span></Tooltip> },
            {
              title: '',
              align: 'right',
              render: (_, d) =>
                can('destinations', 'execute') && (
                  <Button icon={<SyncOutlined />} loading={check.isPending && check.variables === d.id} onClick={() => check.mutate(d.id)}>
                    Check now
                  </Button>
                ),
            },
          ]}
        />
      </Card>

      <Drawer
        title="Add destination folder"
        width={520}
        open={open}
        onClose={() => setOpen(false)}
        afterOpenChange={(o) => !o && setTestResult(null)}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="primary" loading={create.isPending} onClick={() => form.submit()}>
              Save & verify
            </Button>
          </Space>
        }
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 20 }}
          message="Use UNC paths for network shares"
          description={
            <>
              Mapped drives (like Z:) are not visible to Windows services. Use <span className="mv-mono">\\server\share\folder</span>, and give the MailVault service account Modify rights on it. <b>Browse…</b> and <b>Test folder</b> check access as that account.
            </>
          }
        />
        <Form
          form={form}
          layout="vertical"
          requiredMark="optional"
          initialValues={{ createIfMissing: true, lowSpaceThresholdMb: 1024 }}
          onFinish={(v) => create.mutate(v)}
          onValuesChange={(changed) => {
            if ('basePath' in changed || 'createIfMissing' in changed) setTestResult(null);
          }}
        >
          <Form.Item name="name" label="Name" rules={[{ required: true, min: 2 }]}>
            <Input placeholder="Finance – Vendor invoices" />
          </Form.Item>
          <Form.Item label="Folder path" required style={{ marginBottom: 8 }}>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item
                name="basePath"
                noStyle
                rules={[
                  { required: true, message: 'Choose or type a folder' },
                  { pattern: /^([a-zA-Z]:\\|\\\\)/, message: 'Use D:\\... or \\\\server\\share\\...' },
                ]}
              >
                <Input className="mv-mono" placeholder="\\fileserver\Finance\Invoices" />
              </Form.Item>
              <Button icon={<FolderOpenOutlined />} onClick={() => setPicking(true)}>
                Browse…
              </Button>
            </Space.Compact>
          </Form.Item>
          <div style={{ marginBottom: 20 }}>
            <Button size="small" icon={<SafetyCertificateOutlined />} loading={testing} onClick={() => void runTest()}>
              Test folder
            </Button>
            {testResult && <FolderTestResult reply={testResult} />}
          </div>
          <Form.Item name="lowSpaceThresholdMb" label="Low-space warning below (MB)">
            <InputNumber min={100} step={512} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="createIfMissing" label="Create the folder if it doesn't exist" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>

      <FolderPicker
        open={picking}
        initialPath={form.getFieldValue('basePath')}
        onCancel={() => setPicking(false)}
        onSelect={(p) => {
          setPicking(false);
          form.setFieldsValue({ basePath: p });
          void form.validateFields(['basePath']).catch(() => undefined);
          void runTest(p);
        }}
      />
    </>
  );
}

/** Result of "Test folder": writable + free space, or the reason it is not usable. */
function FolderTestResult({ reply }: { reply: FolderOpReply }) {
  const check = reply.ok ? reply.check : undefined;
  const ok = check && check.status !== 'UNAVAILABLE';
  const free = check?.freeMb != null ? fmtBytes(check.freeMb * 1024 * 1024) : null;
  return (
    <Alert
      style={{ marginTop: 10 }}
      type={!ok ? 'error' : check.status === 'LOW_SPACE' ? 'warning' : 'success'}
      showIcon
      message={
        !ok
          ? 'MailVault cannot save files here'
          : check.status === 'LOW_SPACE'
            ? `Writable, but low on space (${free} free)`
            : `Writable · ${free} free`
      }
      description={
        <div style={{ display: 'grid', gap: 4 }}>
          {!ok && <span>{reply.ok ? check?.error : reply.error}</span>}
          <CheckedAs reply={reply} />
        </div>
      }
    />
  );
}
