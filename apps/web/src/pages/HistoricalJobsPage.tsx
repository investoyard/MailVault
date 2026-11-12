import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, DatePicker, Drawer, Form, Progress, Radio, Select, Space, Switch, Table, Tag, Tooltip } from 'antd';
import { CaretRightOutlined, ExperimentOutlined, PlusOutlined, RocketOutlined, StopOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { api } from '../api';
import { useAuth } from '../auth';
import { EmptyState, PageHeader } from '../components/ui';
import { fmtDate, fmtDateTime, fmtNumber } from '../format';

interface Job {
  id: string;
  mailbox: { email: string };
  ruleNames: string[];
  dateFrom: string;
  dateTo: string;
  simulate: boolean;
  includeProcessed: boolean;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  scanned: number;
  matched: number;
  downloaded: number;
  createdAt: string;
  finishedAt: string | null;
  createdBy: string | null;
}

const STATUS: Record<Job['status'], { color: string; label: string }> = {
  QUEUED: { color: 'default', label: 'Queued' },
  RUNNING: { color: 'processing', label: 'Running' },
  COMPLETED: { color: 'green', label: 'Completed' },
  FAILED: { color: 'red', label: 'Failed' },
  CANCELLED: { color: 'orange', label: 'Cancelled' },
};

export function HistoricalJobsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const mailboxId = Form.useWatch('mailboxId', form) as string | undefined;
  const simulate = Form.useWatch('simulate', form) as boolean | undefined;

  const jobs = useQuery({
    queryKey: ['historical-jobs'],
    queryFn: () => api.get<Job[]>('/api/historical-jobs'),
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === 'RUNNING' || j.status === 'QUEUED') ? 3000 : 30_000),
  });
  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<{ id: string; email: string }[]>('/api/mailboxes') });
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api.get<{ id: string; name: string; mailboxId: string; enabled: boolean }[]>('/api/rules') });

  const create = useMutation({
    mutationFn: (v: { mailboxId: string; ruleIds?: string[]; range: [Dayjs, Dayjs]; simulate: boolean; includeProcessed: boolean }) =>
      api.post('/api/historical-jobs', {
        mailboxId: v.mailboxId,
        ruleIds: v.ruleIds ?? [],
        dateFrom: v.range[0].startOf('day').toISOString(),
        dateTo: v.range[1].endOf('day').toISOString(),
        simulate: v.simulate,
        includeProcessed: v.includeProcessed,
      }),
    onSuccess: () => {
      message.success('Historical job started. You will get a notification when it finishes.');
      setOpen(false);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['historical-jobs'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const action = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: 'cancel' | 'resume' }) => api.post(`/api/historical-jobs/${id}/${kind}`),
    onSuccess: (_d, v) => {
      message.success(v.kind === 'cancel' ? 'Job cancelled. Progress is saved; you can resume later.' : 'Job resumed from where it stopped.');
      void qc.invalidateQueries({ queryKey: ['historical-jobs'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="Historical Jobs"
        subtitle="Process older emails on purpose. Simulate first to see what would be saved, then execute."
        extra={
          can('ruleTesting', 'execute') && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
              New historical job
            </Button>
          )
        }
      />

      <Card className="mv-card" styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          loading={jobs.isLoading}
          dataSource={jobs.data ?? []}
          pagination={false}
          locale={{
            emptyText: (
              <EmptyState
                title="No historical jobs yet"
                description="Use a historical job to collect attachments from emails that arrived before MailVault (or a rule) was set up."
                action={can('ruleTesting', 'execute') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>New historical job</Button>}
              />
            ),
          }}
          columns={[
            {
              title: 'Job',
              render: (_, j) => (
                <div>
                  <Space size={6}>
                    <b>{j.mailbox.email}</b>
                    {j.simulate ? <Tag color="purple" icon={<ExperimentOutlined />}>Simulate</Tag> : <Tag color="blue" icon={<RocketOutlined />}>Execute</Tag>}
                    {j.includeProcessed && <Tooltip title="Also processes emails these rules already handled"><Tag>Reprocess</Tag></Tooltip>}
                  </Space>
                  <div className="mv-muted" style={{ fontSize: 12.5 }}>
                    {fmtDate(j.dateFrom)} – {fmtDate(j.dateTo)} · {j.ruleNames.join(', ')}
                  </div>
                </div>
              ),
            },
            { title: 'Status', render: (_, j) => <Tag color={STATUS[j.status].color}>{STATUS[j.status].label}</Tag> },
            {
              title: 'Progress',
              width: 280,
              render: (_, j) => (
                <div>
                  {/* Graph does not report a total in advance, so show live counts instead of a fake percentage. */}
                  {j.status === 'COMPLETED' ? (
                    <Progress percent={100} size="small" showInfo={false} />
                  ) : j.status === 'RUNNING' ? (
                    <Progress percent={100} status="active" size="small" showInfo={false} strokeColor="#B9AEE8" />
                  ) : null}
                  <span className="mv-muted" style={{ fontSize: 12.5 }}>
                    {fmtNumber(j.scanned)} scanned · {fmtNumber(j.matched)} matched{!j.simulate && ` · ${fmtNumber(j.downloaded)} files queued`}
                  </span>
                </div>
              ),
            },
            { title: 'Started', render: (_, j) => <span className="mv-muted">{fmtDateTime(j.createdAt)}{j.createdBy && ` · ${j.createdBy}`}</span>, responsive: ['lg'] },
            {
              title: '',
              align: 'right',
              render: (_, j) =>
                can('ruleTesting', 'execute') &&
                (j.status === 'RUNNING' || j.status === 'QUEUED' ? (
                  <Button icon={<StopOutlined />} danger onClick={() => action.mutate({ id: j.id, kind: 'cancel' })}>
                    Cancel
                  </Button>
                ) : j.status === 'CANCELLED' || j.status === 'FAILED' ? (
                  <Button icon={<CaretRightOutlined />} onClick={() => action.mutate({ id: j.id, kind: 'resume' })}>
                    Resume
                  </Button>
                ) : null),
            },
          ]}
        />
      </Card>

      <Drawer
        title="New historical job"
        width={540}
        open={open}
        onClose={() => setOpen(false)}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="primary" loading={create.isPending} onClick={() => form.submit()}>
              Start job
            </Button>
          </Space>
        }
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ simulate: true, includeProcessed: false, range: [dayjs().subtract(1, 'month').startOf('month'), dayjs().subtract(1, 'day')] }}
          onFinish={(v) => create.mutate(v)}
        >
          <Form.Item name="mailboxId" label="Email account" rules={[{ required: true, message: 'Choose a mailbox' }]}>
            <Select placeholder="Select mailbox" options={(mailboxes.data ?? []).map((m) => ({ value: m.id, label: m.email }))} />
          </Form.Item>
          <Form.Item name="ruleIds" label="Rules" tooltip="Leave empty to use every enabled rule of this mailbox.">
            <Select
              mode="multiple"
              placeholder="All enabled rules"
              disabled={!mailboxId}
              options={(rules.data ?? []).filter((r) => r.mailboxId === mailboxId).map((r) => ({ value: r.id, label: r.enabled ? r.name : `${r.name} (disabled)` }))}
            />
          </Form.Item>
          <Form.Item name="range" label="Emails received between" rules={[{ required: true }]}>
            <DatePicker.RangePicker style={{ width: '100%' }} disabledDate={(d) => d.isAfter(dayjs())} />
          </Form.Item>
          <Form.Item name="simulate" label="Mode">
            <Radio.Group style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Radio value={true}>
                <b>Simulate</b>
                <div className="mv-muted" style={{ fontSize: 12.5 }}>Shows in History what would be saved and where. No files are written.</div>
              </Radio>
              <Radio value={false}>
                <b>Execute</b>
                <div className="mv-muted" style={{ fontSize: 12.5 }}>Downloads the matching attachments to the rules' folders.</div>
              </Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="includeProcessed" label="Also process emails these rules already handled" valuePropName="checked" tooltip="Turn on to execute after a simulation, or to download again on purpose.">
            <Switch />
          </Form.Item>
          {simulate === false && (
            <Alert type="warning" showIcon message="Execute writes files" description="Duplicates follow each rule's duplicate policy. Large date ranges can take a while; the job runs in the background and can be cancelled." />
          )}
        </Form>
      </Drawer>
    </>
  );
}
