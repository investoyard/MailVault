import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, DatePicker, Input, Select, Table, Tabs, Tag, Typography } from 'antd';
import { FileExcelOutlined, SearchOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { api, qs } from '../api';
import { EmptyState, PageHeader } from '../components/ui';
import { fmtDateTime, fmtNumber } from '../format';

interface AuditRow {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: string;
  user: { username: string; displayName: string } | null;
}

interface ProcRow {
  id: string;
  level: string;
  source: string;
  message: string;
  correlationId: string | null;
  createdAt: string;
}

const LEVEL_COLOR: Record<string, string> = { error: 'red', warn: 'orange', info: 'blue', debug: 'default' };

function AuditTab() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [userId, setUserId] = useState<string | undefined>();
  const [action, setAction] = useState<string | undefined>();
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const filters = {
    search,
    userId,
    action,
    from: range?.[0]?.startOf('day').toISOString(),
    to: range?.[1]?.endOf('day').toISOString(),
  };
  const q = useQuery({
    queryKey: ['audit', page, filters],
    queryFn: () => api.get<{ total: number; rows: AuditRow[] }>(`/api/logs/audit${qs({ page, pageSize: 50, ...filters })}`),
    placeholderData: (p) => p,
  });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ id: string; displayName: string }[]>('/api/users'), retry: false });
  const actions = useQuery({ queryKey: ['audit-actions'], queryFn: () => api.get<{ action: string; count: number }[]>('/api/logs/audit/actions') });
  const reset = (fn: () => void) => {
    fn();
    setPage(1);
  };
  return (
    <>
      <div className="mv-filter-bar">
        <Input.Search allowClear placeholder="Search action, entity or ID" style={{ width: 260 }} onSearch={(v) => reset(() => setSearch(v))} enterButton={<SearchOutlined />} />
        <Select
          allowClear
          placeholder="Any user"
          style={{ width: 200 }}
          value={userId}
          onChange={(v) => reset(() => setUserId(v))}
          options={[{ value: 'system', label: 'System (automatic)' }, ...(users.data ?? []).map((u) => ({ value: u.id, label: u.displayName }))]}
        />
        <Select
          allowClear
          showSearch
          placeholder="Any action"
          style={{ width: 240 }}
          value={action}
          onChange={(v) => reset(() => setAction(v))}
          options={(actions.data ?? []).map((a) => ({ value: a.action, label: `${a.action} (${a.count})` }))}
        />
        <DatePicker.RangePicker value={range} onChange={(v) => reset(() => setRange(v as [Dayjs, Dayjs] | null))} />
        <Button icon={<FileExcelOutlined />} href={`/api/logs/audit/export${qs(filters)}`} disabled={!q.data?.total}>
          Export to Excel
        </Button>
      </div>
      <Table
        className="mv-table"
        rowKey="id"
        size="middle"
        loading={q.isFetching}
        dataSource={q.data?.rows ?? []}
        locale={{ emptyText: <EmptyState title="No audit entries" /> }}
        pagination={{ current: page, pageSize: 50, total: q.data?.total ?? 0, onChange: setPage, showTotal: (t) => `${fmtNumber(t)} entries`, showSizeChanger: false }}
        expandable={{
          rowExpandable: (r) => r.before != null || r.after != null,
          expandedRowRender: (r) => (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              {(['before', 'after'] as const).map((k) => (
                <div key={k}>
                  <Typography.Text type="secondary" style={{ textTransform: 'capitalize' }}>{k}</Typography.Text>
                  <pre className="mv-mono" style={{ background: '#F8FAFC', padding: 12, borderRadius: 8, margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>
                    {r[k] != null ? JSON.stringify(r[k], null, 2) : '—'}
                  </pre>
                </div>
              ))}
            </div>
          ),
        }}
        columns={[
          { title: 'When', dataIndex: 'createdAt', width: 180, render: fmtDateTime },
          { title: 'User', width: 180, render: (_, r) => r.user?.displayName ?? <span className="mv-muted">System</span> },
          { title: 'Action', dataIndex: 'action', render: (a: string) => <Tag color={a.includes('FAILED') ? 'red' : undefined}>{a}</Tag> },
          { title: 'Entity', render: (_, r) => (r.entityType ? `${r.entityType}${r.entityId ? ` · ${r.entityId.slice(0, 10)}` : ''}` : '—') },
          { title: 'IP', dataIndex: 'ip', width: 140, render: (v: string | null) => <span className="mv-mono mv-muted">{v ?? '—'}</span> },
        ]}
      />
    </>
  );
}

function ProcessingTab({ initialCorrelation }: { initialCorrelation?: string }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState<string | undefined>();
  const [correlationId, setCorrelationId] = useState(initialCorrelation ?? '');
  const q = useQuery({
    queryKey: ['proc-logs', page, search, level, correlationId],
    queryFn: () => api.get<{ total: number; rows: ProcRow[] }>(`/api/logs/processing${qs({ page, pageSize: 50, search, level, correlationId })}`),
    placeholderData: (p) => p,
  });
  return (
    <>
      <div className="mv-filter-bar">
        <Input.Search allowClear placeholder="Search message" style={{ width: 280 }} onSearch={(v) => { setSearch(v); setPage(1); }} />
        <Select allowClear placeholder="Any level" style={{ width: 150 }} value={level} onChange={(v) => { setLevel(v); setPage(1); }} options={['error', 'warn', 'info'].map((l) => ({ value: l, label: l }))} />
        <Input allowClear placeholder="Trace (correlation) ID" className="mv-mono" style={{ width: 320 }} value={correlationId} onChange={(e) => { setCorrelationId(e.target.value); setPage(1); }} />
      </div>
      <Table
        className="mv-table"
        rowKey="id"
        size="middle"
        loading={q.isFetching}
        dataSource={q.data?.rows ?? []}
        locale={{ emptyText: <EmptyState title="No log entries" /> }}
        pagination={{ current: page, pageSize: 50, total: q.data?.total ?? 0, onChange: setPage, showTotal: (t) => `${fmtNumber(t)} entries`, showSizeChanger: false }}
        columns={[
          { title: 'When', dataIndex: 'createdAt', width: 180, render: fmtDateTime },
          { title: 'Level', dataIndex: 'level', width: 90, render: (l: string) => <Tag color={LEVEL_COLOR[l]}>{l}</Tag> },
          { title: 'Source', dataIndex: 'source', width: 150 },
          { title: 'Message', dataIndex: 'message' },
          { title: 'Trace', dataIndex: 'correlationId', width: 120, render: (c: string | null) => (c ? <a className="mv-mono" onClick={() => setCorrelationId(c)}>{c.slice(0, 8)}</a> : '—') },
        ]}
      />
    </>
  );
}

export function LogsPage() {
  const [params] = useSearchParams();
  const correlation = params.get('correlationId') ?? undefined;
  return (
    <>
      <PageHeader title="Audit & Logs" subtitle="Who changed what, and a full trace of every sync and download." />
      <Card className="mv-card">
        <Tabs
          defaultActiveKey={correlation ? 'processing' : 'audit'}
          items={[
            { key: 'audit', label: 'Audit trail', children: <AuditTab /> },
            { key: 'processing', label: 'Processing logs', children: <ProcessingTab initialCorrelation={correlation} /> },
          ]}
        />
      </Card>
    </>
  );
}
