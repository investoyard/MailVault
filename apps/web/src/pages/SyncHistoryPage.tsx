import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Card, Col, Row, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  FileSearchOutlined,
  InboxOutlined,
  ReloadOutlined,
  SyncOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { api, qs } from '../api';
import { EmptyState, PageHeader, StatCard } from '../components/ui';
import { fmtDateTime, fmtNumber, fromNow } from '../format';

interface SyncRunRow {
  id: string;
  mailboxId: string;
  mailbox: string;
  trigger: 'AUTO' | 'MANUAL_SYNC' | string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  scanned: number;
  newMessages: number;
  matched: number;
  error: string | null;
  correlationId: string;
  status: 'OK' | 'FAILED' | 'RUNNING' | 'STOPPED';
}

interface SyncRunsResponse {
  total: number;
  summary: { runs24h: number; failed24h: number; newMessages24h: number; matched24h: number; lastSuccessAt: string | null };
  rows: SyncRunRow[];
}

const duration = (ms: number | null) => (ms === null ? '—' : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

function StatusTag({ r }: { r: SyncRunRow }) {
  switch (r.status) {
    case 'OK':
      return <Tag color="green" icon={<CheckCircleOutlined />}>Completed</Tag>;
    case 'FAILED':
      return <Tag color="red" icon={<CloseCircleOutlined />}>Failed</Tag>;
    case 'RUNNING':
      return <Tag color="processing" icon={<SyncOutlined spin />}>Running</Tag>;
    default:
      return (
        <Tooltip title="The worker stopped before this check finished (for example during a restart). The next check picks up where it left off.">
          <Tag icon={<ClockCircleOutlined />}>Stopped</Tag>
        </Tooltip>
      );
  }
}

export function SyncHistoryPage() {
  const [params, setParams] = useSearchParams();
  const mailboxId = params.get('mailboxId') ?? undefined;
  const [trigger, setTrigger] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<{ id: string; email: string }[]>('/api/mailboxes') });
  // 'sync-runs' is refreshed by the live-update stream in AppLayout after every sync.
  const q = useQuery({
    queryKey: ['sync-runs', mailboxId, trigger, status, page, pageSize],
    queryFn: () => api.get<SyncRunsResponse>(`/api/sync-runs${qs({ mailboxId, trigger, status, page, pageSize })}`),
    refetchInterval: 60_000,
  });
  const s = q.data?.summary;

  const setMailbox = (id?: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('mailboxId', id);
    else next.delete('mailboxId');
    setParams(next, { replace: true });
    setPage(1);
  };

  return (
    <>
      <PageHeader
        title="Sync History"
        subtitle={'Every mailbox check: the automatic ones on the "Check mailboxes every" schedule and each "Sync now".'}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => q.refetch()} loading={q.isFetching}>
            Refresh
          </Button>
        }
      />

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={12} xl={6}>
          <StatCard label="Checks (last 24 h)" value={fmtNumber(s?.runs24h ?? 0)} icon={<SyncOutlined />} foot={mailboxId ? 'This mailbox' : 'All mailboxes'} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatCard
            label="Failed (last 24 h)"
            value={fmtNumber(s?.failed24h ?? 0)}
            icon={<CloseCircleOutlined />}
            tone={s?.failed24h ? 'error' : 'success'}
            foot={s?.failed24h ? <a onClick={() => { setStatus('failed'); setPage(1); }}>Show failed checks</a> : 'No problems'}
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatCard label="New emails (last 24 h)" value={fmtNumber(s?.newMessages24h ?? 0)} icon={<InboxOutlined />} tone="info" foot={`${fmtNumber(s?.matched24h ?? 0)} matched a rule`} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatCard
            label="Last successful check"
            value={s?.lastSuccessAt ? fromNow(s.lastSuccessAt) : '—'}
            icon={<CheckCircleOutlined />}
            tone="success"
            foot={s?.lastSuccessAt ? fmtDateTime(s.lastSuccessAt) : 'None yet'}
          />
        </Col>
      </Row>

      <Card className="mv-card" styles={{ body: { padding: 0 } }}>
        <Space wrap style={{ padding: 16 }}>
          <Select
            allowClear
            placeholder="All mailboxes"
            style={{ width: 260 }}
            value={mailboxId}
            onChange={setMailbox}
            options={(mailboxes.data ?? []).map((m) => ({ value: m.id, label: m.email }))}
          />
          <Select
            allowClear
            placeholder="Automatic and Sync now"
            style={{ width: 220 }}
            value={trigger}
            onChange={(v) => { setTrigger(v); setPage(1); }}
            options={[
              { value: 'AUTO', label: 'Automatic only' },
              { value: 'MANUAL_SYNC', label: 'Sync now only' },
            ]}
          />
          <Select
            allowClear
            placeholder="Any result"
            style={{ width: 200 }}
            value={status}
            onChange={(v) => { setStatus(v); setPage(1); }}
            options={[
              { value: 'ok', label: 'Completed' },
              { value: 'failed', label: 'Failed' },
              { value: 'new-mail', label: 'Found new emails' },
              { value: 'running', label: 'Running' },
            ]}
          />
        </Space>
        <Table
          rowKey="id"
          loading={q.isLoading}
          dataSource={q.data?.rows ?? []}
          pagination={{
            current: page,
            pageSize,
            total: q.data?.total ?? 0,
            showSizeChanger: true,
            showTotal: (t) => `${fmtNumber(t)} checks`,
            onChange: (p, ps) => { setPage(p); setPageSize(ps); },
          }}
          locale={{
            emptyText: (
              <EmptyState
                title={trigger || status ? 'No checks match these filters' : 'No mailbox checks yet'}
                description="Checks appear here as soon as the worker looks at a mailbox, automatically or with Sync now on Email Accounts."
              />
            ),
          }}
          columns={[
            {
              title: 'Started',
              width: 190,
              render: (_, r) => (
                <div>
                  <div style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.startedAt)}</div>
                  <div className="mv-muted" style={{ fontSize: 12.5 }}>{fromNow(r.startedAt)}</div>
                </div>
              ),
            },
            { title: 'Mailbox', render: (_, r) => <b>{r.mailbox}</b> },
            {
              title: 'Type',
              width: 130,
              render: (_, r) =>
                r.trigger === 'AUTO' ? (
                  <Tooltip title='Scheduled check (Settings → "Check mailboxes every")'>
                    <Tag icon={<ClockCircleOutlined />}>Automatic</Tag>
                  </Tooltip>
                ) : (
                  <Tag color="purple" icon={<UserOutlined />}>Sync now</Tag>
                ),
            },
            {
              title: 'Result',
              render: (_, r) => (
                <div>
                  <StatusTag r={r} />
                  {r.error && (
                    <Typography.Paragraph type="danger" style={{ margin: '4px 0 0', fontSize: 12.5, maxWidth: 420 }} ellipsis={{ rows: 2, tooltip: r.error }}>
                      {r.error}
                    </Typography.Paragraph>
                  )}
                </div>
              ),
            },
            {
              title: 'New emails',
              align: 'right',
              width: 110,
              render: (_, r) => (
                <Tooltip title={`${fmtNumber(r.scanned)} change(s) read from Microsoft 365`}>
                  <span style={{ fontWeight: r.newMessages ? 600 : 400 }} className={r.newMessages ? undefined : 'mv-muted'}>
                    {fmtNumber(r.newMessages)}
                  </span>
                </Tooltip>
              ),
            },
            {
              title: 'Matched a rule',
              align: 'right',
              width: 130,
              render: (_, r) =>
                r.matched ? (
                  <Link to={`/history?mailboxId=${r.mailboxId}`}>
                    <b>{fmtNumber(r.matched)}</b>
                  </Link>
                ) : (
                  <span className="mv-muted">0</span>
                ),
            },
            { title: 'Took', align: 'right', width: 100, responsive: ['lg'], render: (_, r) => <span className="mv-muted">{duration(r.durationMs)}</span> },
            {
              title: '',
              align: 'right',
              width: 60,
              render: (_, r) => (
                <Tooltip title="Full trace in the Processing log">
                  <Link to={`/logs?correlationId=${r.correlationId}`}>
                    <Button size="small" icon={<FileSearchOutlined />} aria-label="Open trace" />
                  </Link>
                </Tooltip>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}
