import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Drawer, Form, Input, InputNumber, Space, Switch, Table, Tooltip, Typography } from 'antd';
import { CopyOutlined, FolderOpenOutlined, PlusOutlined, SyncOutlined } from '@ant-design/icons';
import type { DestinationStatus } from '@mailvault/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { DestinationStatusTag, EmptyState, PageHeader } from '../components/ui';
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

  const q = useQuery({ queryKey: ['destinations'], queryFn: () => api.get<Destination[]>('/api/destinations') });

  const create = useMutation({
    mutationFn: (v: object) => api.post<Destination>('/api/destinations', v),
    onSuccess: (d) => {
      if (d.status === 'UNAVAILABLE') message.warning(`Saved, but the folder is not accessible: ${d.lastError}`);
      else message.success('Destination folder added and verified');
      setOpen(false);
      form.resetFields();
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
              Mapped drives (like Z:) are not visible to Windows services. Use <span className="mv-mono">\\server\share\folder</span>, and give the MailVault service account Modify rights on it.
            </>
          }
        />
        <Form form={form} layout="vertical" requiredMark="optional" initialValues={{ createIfMissing: true, lowSpaceThresholdMb: 1024 }} onFinish={(v) => create.mutate(v)}>
          <Form.Item name="name" label="Name" rules={[{ required: true, min: 2 }]}>
            <Input placeholder="Finance – Vendor invoices" />
          </Form.Item>
          <Form.Item
            name="basePath"
            label="Folder path"
            rules={[
              { required: true },
              { pattern: /^([a-zA-Z]:\\|\\\\)/, message: 'Use D:\\... or \\\\server\\share\\...' },
            ]}
          >
            <Input className="mv-mono" placeholder="\\fileserver\Finance\Invoices" />
          </Form.Item>
          <Form.Item name="lowSpaceThresholdMb" label="Low-space warning below (MB)">
            <InputNumber min={100} step={512} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="createIfMissing" label="Create the folder if it doesn't exist" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>
    </>
  );
}
