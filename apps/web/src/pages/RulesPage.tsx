import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Input, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { ExperimentOutlined, PlusOutlined, SearchOutlined, StopOutlined } from '@ant-design/icons';
import type { DestinationStatus } from '@mailvault/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { DestinationStatusTag, EmptyState, PageHeader } from '../components/ui';
import { fmtNumber } from '../format';

interface Rule {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  priority: number;
  stopFurtherRules: boolean;
  simulationMode: boolean;
  autoDownload: boolean;
  duplicatePolicy: string;
  currentVersion: number;
  conditions: { senderInclude?: string[]; subjectContains?: string; subjectKeywords?: string[] };
  attachments: { mode: string; extensions?: string[] };
  download: { subfolderPattern?: string };
  mailbox: { email: string };
  destination: { name: string; basePath: string; status: DestinationStatus };
  _count: { matches: number };
}

function conditionSummary(r: Rule): string {
  const parts: string[] = [];
  if (r.conditions.senderInclude?.length) parts.push(`From ${r.conditions.senderInclude.slice(0, 2).join(', ')}${r.conditions.senderInclude.length > 2 ? '…' : ''}`);
  if (r.conditions.subjectContains) parts.push(`Subject contains "${r.conditions.subjectContains}"`);
  if (r.conditions.subjectKeywords?.length) parts.push(`Keywords: ${r.conditions.subjectKeywords.join(', ')}`);
  if (r.attachments.mode === 'SELECTED' && r.attachments.extensions?.length) parts.push(r.attachments.extensions.map((e) => e.toUpperCase()).join(', '));
  return parts.join(' · ') || 'All emails with attachments';
}

export function RulesPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [mailbox, setMailbox] = useState<string | undefined>();

  const q = useQuery({ queryKey: ['rules'], queryFn: () => api.get<Rule[]>('/api/rules') });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/api/rules/${id}/enabled`, { enabled }),
    onSuccess: (_d, v) => {
      message.success(v.enabled ? 'Rule enabled' : 'Rule disabled (kept, not deleted)');
      void qc.invalidateQueries({ queryKey: ['rules'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const mailboxes = useMemo(() => [...new Set((q.data ?? []).map((r) => r.mailbox.email))], [q.data]);
  const rows = (q.data ?? []).filter(
    (r) => (!mailbox || r.mailbox.email === mailbox) && (!search || `${r.name} ${r.description ?? ''}`.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <>
      <PageHeader
        title="Download Rules"
        subtitle="Rules decide which emails are picked up and where their attachments are saved. Lower priority numbers run first."
        extra={
          can('rules', 'create') && (
            <Tooltip title="The full rule editor (conditions, attachment filters, destination, test) arrives in Phase 1.">
              <Button type="primary" icon={<PlusOutlined />} disabled>
                New rule
              </Button>
            </Tooltip>
          )
        }
      />

      <div className="mv-filter-bar">
        <Input allowClear prefix={<SearchOutlined className="mv-muted" />} placeholder="Search rules" style={{ width: 260 }} value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select allowClear placeholder="All mailboxes" style={{ width: 260 }} value={mailbox} onChange={setMailbox} options={mailboxes.map((m) => ({ value: m, label: m }))} />
      </div>

      <Card className="mv-card" styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          loading={q.isLoading}
          dataSource={rows}
          pagination={rows.length > 20 ? { pageSize: 20 } : false}
          locale={{ emptyText: <EmptyState title="No download rules yet" description="Rules match emails by sender, subject and attachment type, then save files to a destination folder." /> }}
          columns={[
            { title: '#', dataIndex: 'priority', width: 64, render: (p: number) => <Tag style={{ fontVariantNumeric: 'tabular-nums' }}>{p}</Tag> },
            {
              title: 'Rule',
              render: (_, r) => (
                <div style={{ maxWidth: 420 }}>
                  <Space size={6} wrap>
                    <span style={{ fontWeight: 600 }}>{r.name}</span>
                    {r.simulationMode && <Tag color="purple" icon={<ExperimentOutlined />}>Simulation</Tag>}
                    {r.stopFurtherRules && <Tooltip title="Stops other rules from processing the same email"><Tag icon={<StopOutlined />}>Stops further rules</Tag></Tooltip>}
                    {!r.autoDownload && <Tag color="blue">Manual download</Tag>}
                  </Space>
                  <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12.5 }}>
                    {conditionSummary(r)}
                  </Typography.Text>
                </div>
              ),
            },
            { title: 'Mailbox', render: (_, r) => <span className="mv-muted">{r.mailbox.email}</span>, responsive: ['lg'] },
            {
              title: 'Destination',
              responsive: ['md'],
              width: 280,
              render: (_, r) => (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 500 }}>{r.destination.name}</span>
                    <DestinationStatusTag status={r.destination.status} />
                  </div>
                  {r.download.subfolderPattern && (
                    <Typography.Text className="mv-mono mv-muted" ellipsis style={{ display: 'block', maxWidth: 260 }}>
                      …\{r.download.subfolderPattern}
                    </Typography.Text>
                  )}
                </div>
              ),
            },
            { title: 'Matches', align: 'right', render: (_, r) => fmtNumber(r._count.matches) },
            { title: 'Version', align: 'center', responsive: ['xl'], render: (_, r) => <span className="mv-muted">v{r.currentVersion}</span> },
            {
              title: 'Enabled',
              align: 'center',
              render: (_, r) => (
                <Switch checked={r.enabled} disabled={!can('rules', 'edit')} loading={toggle.isPending && toggle.variables?.id === r.id} onChange={(enabled) => toggle.mutate({ id: r.id, enabled })} />
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}
