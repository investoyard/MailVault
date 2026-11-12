import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Col, Progress, Row, Segmented, Select, Skeleton, Table, Tooltip, Typography } from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CloudDownloadOutlined,
  MailOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import dayjs from 'dayjs';
import type { DestinationStatus, DownloadStatus, MailboxStatus } from '@mailvault/shared';
import { api } from '../api';
import { DownloadStatusTag, EmptyState, PageHeader, StatCard, destinationColor, mailboxColor } from '../components/ui';
import { fmtBytes, fmtNumber, fromNow } from '../format';
import { palette } from '../theme';

interface Summary {
  kpis: {
    emailsScanned: number;
    emailsMatched: number;
    downloadsTotal: number;
    success: number;
    failed: number;
    skipped: number;
    pending: number;
    today: { emailsScanned: number; success: number; failed: number; skipped: number };
  };
  trend: { day: string; success: number; failed: number; skipped: number }[];
  ruleStats: { ruleId: string; ruleName: string; mailbox: string; success: number; failed: number; skipped: number }[];
  recent: {
    id: string;
    status: DownloadStatus;
    fileName: string;
    sizeBytes: number;
    ruleName: string;
    sender: string;
    subject: string;
    mailbox: string;
    note: string | null;
    at: string;
  }[];
  mailboxes: { id: string; email: string; displayName: string | null; status: MailboxStatus; lastSyncAt: string | null; lastError: string | null }[];
  destinations: { id: string; name: string; basePath: string; status: DestinationStatus; freeSpaceMb: number | null }[];
  worker: { online: boolean; lastBeatAt: string } | null;
}

export function DashboardPage() {
  const navigate = useNavigate();
  const [days, setDays] = useState(14);
  const [mailboxId, setMailboxId] = useState<string | undefined>();
  const mailboxList = useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<{ id: string; email: string }[]>('/api/mailboxes') });
  const q = useQuery({
    queryKey: ['dashboard', days, mailboxId],
    queryFn: () => api.get<Summary>(`/api/dashboard/summary?days=${days}${mailboxId ? `&mailboxId=${mailboxId}` : ""}`),
    refetchInterval: 30_000,
  });
  const d = q.data;
  const k = d?.kpis;
  const successRate = k && k.downloadsTotal > 0 ? Math.round((k.success / k.downloadsTotal) * 100) : null;
  const maxRule = Math.max(1, ...(d?.ruleStats.map((r) => r.success + r.failed + r.skipped) ?? [1]));

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Overview of email processing · updated ${q.dataUpdatedAt ? fromNow(new Date(q.dataUpdatedAt)) : '…'}`}
        extra={
          <>
          <Select allowClear placeholder="All mailboxes" style={{ width: 260 }} value={mailboxId} onChange={setMailboxId} options={(mailboxList.data ?? []).map((m) => ({ value: m.id, label: m.email }))} />
          <Button icon={<ReloadOutlined />} onClick={() => q.refetch()} loading={q.isFetching}>
            Refresh
          </Button>
          </>
        }
      />

      <Row gutter={[16, 16]}>
        {[
          { label: 'Emails scanned', value: k?.emailsScanned, icon: <MailOutlined />, tone: 'primary' as const, foot: `${fmtNumber(k?.emailsMatched)} matched a rule` },
          { label: 'Attachments downloaded', value: k?.downloadsTotal, icon: <CloudDownloadOutlined />, tone: 'info' as const, foot: `${fmtNumber(k?.skipped)} skipped by filters` },
          { label: 'Successful', value: k?.success, icon: <CheckCircleOutlined />, tone: 'success' as const, foot: successRate === null ? 'No downloads yet' : `${successRate}% success rate` },
          { label: 'Failed', value: k?.failed, icon: <CloseCircleOutlined />, tone: 'error' as const, foot: k?.failed ? 'Open History to retry' : 'Nothing needs attention' },
          { label: 'Pending', value: k?.pending, icon: <ClockCircleOutlined />, tone: 'warning' as const, foot: 'Queued, retrying or waiting' },
          {
            label: "Today's downloads",
            value: k?.today.success,
            icon: <ThunderboltOutlined />,
            tone: 'neutral' as const,
            foot: `${fmtNumber(k?.today.emailsScanned)} emails · ${fmtNumber(k?.today.failed)} failed`,
          },
        ].map((s) => (
          <Col xs={24} sm={12} lg={8} xxl={4} key={s.label}>
            {q.isLoading ? (
              <div className="mv-stat">
                <Skeleton active paragraph={{ rows: 1 }} />
              </div>
            ) : (
              <StatCard label={s.label} value={fmtNumber(s.value)} icon={s.icon} tone={s.tone} foot={s.foot} />
            )}
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={16}>
          <Card
            className="mv-card"
            style={{ height: '100%' }}
            title="Download trend"
            extra={<Segmented size="small" value={days} onChange={(v) => setDays(v as number)} options={[{ label: '7 days', value: 7 }, { label: '14 days', value: 14 }, { label: '30 days', value: 30 }]} />}
          >
            <div style={{ height: 280 }}>
              {q.isLoading ? (
                <Skeleton active />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={d?.trend ?? []} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gSuccess" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={palette.primary} stopOpacity={0.22} />
                        <stop offset="100%" stopColor={palette.primary} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gFailed" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={palette.error} stopOpacity={0.18} />
                        <stop offset="100%" stopColor={palette.error} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#EEF1F6" vertical={false} />
                    <XAxis dataKey="day" tickFormatter={(v: string) => dayjs(v).format('DD MMM')} tick={{ fontSize: 12, fill: '#94A3B8' }} axisLine={false} tickLine={false} minTickGap={16} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
                    <RTooltip
                      labelFormatter={(v) => dayjs(String(v)).format('ddd, DD MMM YYYY')}
                      contentStyle={{ borderRadius: 10, border: `1px solid ${palette.border}`, boxShadow: '0 8px 24px rgba(15,23,42,.08)' }}
                    />
                    <Area type="monotone" dataKey="success" name="Successful" stroke={palette.primary} strokeWidth={2} fill="url(#gSuccess)" />
                    <Area type="monotone" dataKey="failed" name="Failed" stroke={palette.error} strokeWidth={2} fill="url(#gFailed)" />
                    <Area type="monotone" dataKey="skipped" name="Skipped" stroke="#94A3B8" strokeWidth={1.5} strokeDasharray="4 4" fill="transparent" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>
        </Col>

        <Col xs={24} xl={8}>
          <Card className="mv-card" title="Downloads by rule" extra={<Button type="link" size="small" onClick={() => navigate('/rules')}>All rules</Button>} style={{ height: '100%' }}>
            {q.isLoading ? (
              <Skeleton active />
            ) : !d?.ruleStats.length ? (
              <EmptyState title="No rules yet" description="Create a download rule to start collecting attachments." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {d.ruleStats.map((r) => {
                  const total = r.success + r.failed + r.skipped;
                  return (
                    <div key={r.ruleId}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <Typography.Text strong ellipsis style={{ maxWidth: '70%' }}>
                          {r.ruleName}
                        </Typography.Text>
                        <span className="mv-muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {fmtNumber(r.success)}
                          {r.failed > 0 && <span style={{ color: palette.error }}> · {r.failed} failed</span>}
                        </span>
                      </div>
                      <Tooltip title={`${r.success} successful · ${r.failed} failed · ${r.skipped} skipped`}>
                        <Progress percent={(total / maxRule) * 100} success={{ percent: (r.success / maxRule) * 100, strokeColor: palette.primary }} strokeColor={palette.error} showInfo={false} size="small" />
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={16}>
          <Card className="mv-card" title="Recent activity" extra={<Button type="link" size="small" onClick={() => navigate('/history')}>View history</Button>} styles={{ body: { padding: 0 } }}>
            <Table
              rowKey="id"
              size="middle"
              loading={q.isLoading}
              pagination={false}
              dataSource={d?.recent ?? []}
              locale={{ emptyText: <EmptyState title="No activity yet" description="Downloaded attachments will appear here as soon as the first rule matches an email." /> }}
              columns={[
                {
                  title: 'Attachment',
                  render: (_, r) => (
                    <div style={{ minWidth: 200 }}>
                      <div style={{ fontWeight: 500 }}>{r.fileName}</div>
                      <div className="mv-muted" style={{ fontSize: 12.5 }}>
                        {r.sender} · {fmtBytes(r.sizeBytes)}
                      </div>
                    </div>
                  ),
                },
                { title: 'Rule', dataIndex: 'ruleName', responsive: ['md'] },
                { title: 'Status', dataIndex: 'status', render: (s: DownloadStatus, r) => (r.note ? <Tooltip title={r.note}><span><DownloadStatusTag status={s} /></span></Tooltip> : <DownloadStatusTag status={s} />) },
                { title: 'When', dataIndex: 'at', width: 130, render: (v: string) => <span className="mv-muted">{fromNow(v)}</span> },
              ]}
            />
          </Card>
        </Col>

        <Col xs={24} xl={8}>
          <Card className="mv-card" title="Mailbox health" extra={<Button type="link" size="small" onClick={() => navigate('/accounts')}>Manage</Button>}>
            {!d?.mailboxes.length ? (
              <EmptyState title="No mailboxes connected" action={<Button type="primary" onClick={() => navigate('/accounts')}>Add email account</Button>} />
            ) : (
              d.mailboxes.map((m) => (
                <div className="mv-health-row" key={m.id}>
                  <span className="mv-dot" style={{ background: mailboxColor(m.status) }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Typography.Text ellipsis style={{ display: 'block', fontWeight: 500 }}>{m.email}</Typography.Text>
                    <span className="mv-muted" style={{ fontSize: 12.5 }}>
                      {m.lastError ?? `Last sync ${fromNow(m.lastSyncAt)}`}
                    </span>
                  </div>
                </div>
              ))
            )}
          </Card>

          <Card className="mv-card" title="Destination folders" style={{ marginTop: 16 }} extra={<Button type="link" size="small" onClick={() => navigate('/destinations')}>Manage</Button>}>
            {!d?.destinations.length ? (
              <EmptyState title="No folders configured" />
            ) : (
              d.destinations.map((f) => (
                <div className="mv-health-row" key={f.id}>
                  <span className="mv-dot" style={{ background: destinationColor(f.status) }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Typography.Text ellipsis style={{ display: 'block', fontWeight: 500 }}>{f.name}</Typography.Text>
                    <Typography.Text ellipsis className="mv-mono mv-muted" style={{ display: 'block' }}>{f.basePath}</Typography.Text>
                  </div>
                  <span className="mv-muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                    {f.freeSpaceMb !== null ? `${fmtBytes(f.freeSpaceMb * 1024 * 1024)} free` : '—'}
                  </span>
                </div>
              ))
            )}
          </Card>
        </Col>
      </Row>
    </>
  );
}
