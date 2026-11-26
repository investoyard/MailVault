import { useNavigate } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Input, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { EditOutlined, ExperimentOutlined, PlusOutlined, SearchOutlined, StopOutlined } from '@ant-design/icons';
import type { DestinationStatus } from '@mailvault/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { DestinationStatusTag, EmptyState, PageHeader } from '../components/ui';
import { useConfirm } from '../components/confirm';
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
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [mailbox, setMailbox] = useState<string | undefined>();
  const navigate = useNavigate();
  const openEdit = (id: string) => navigate(`/rules/${id}`);

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
  // Serial number in run order (the API sorts by mailbox, priority, then oldest first), kept while searching/filtering.
  const seq = useMemo(() => new Map((q.data ?? []).map((r, i) => [r.id, i + 1])), [q.data]);
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
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/rules/new')}>
              New rule
            </Button>
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
          tableLayout="fixed"
          loading={q.isLoading}
          dataSource={rows}
          pagination={rows.length > 20 ? { pageSize: 20 } : false}
          locale={{ emptyText: <EmptyState title="No download rules yet" description="Rules match emails by sender, subject and attachment type, then save files to a destination folder." /> }}
          columns={[
            { title: '#', width: 56, render: (_, r) => <span className="mv-muted" style={{ fontVariantNumeric: 'tabular-nums' }}>{seq.get(r.id)}</span> },
            {
              title: 'Rule',
              render: (_, r) => (
                <div style={{ minWidth: 0 }}>
                  <Space size={6} wrap>
                    <span style={{ fontWeight: 600 }}>{r.name}</span>
                    {r.simulationMode && <Tag color="purple" icon={<ExperimentOutlined />}>Simulation</Tag>}
                    {r.stopFurtherRules && <Tooltip title="Stops other rules from processing the same email"><Tag icon={<StopOutlined />}>Stops further rules</Tag></Tooltip>}
                    {!r.autoDownload && <Tag color="blue">Manual download</Tag>}
                  </Space>
                  <Typography.Text type="secondary" ellipsis={{ tooltip: conditionSummary(r) }} style={{ display: 'block', fontSize: 12.5 }}>
                    {conditionSummary(r)}
                  </Typography.Text>
                  <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
                    {r.mailbox.email}
                  </Typography.Text>
                </div>
              ),
            },
            {
              title: (
                <Tooltip title="Lower numbers run first. Rules with the same priority run oldest first.">
                  <span>Priority</span>
                </Tooltip>
              ),
              width: 90,
              align: 'center',
              responsive: ['lg'],
              render: (_, r) => <Tag style={{ marginInlineEnd: 0, fontVariantNumeric: 'tabular-nums' }}>{r.priority}</Tag>,
            },
            {
              title: 'Destination',
              responsive: ['md'],
              width: '30%',
              render: (_, r) => (
                <div style={{ minWidth: 0 }}>
                  <Typography.Text ellipsis={{ tooltip: r.destination.basePath }} style={{ display: 'block', fontWeight: 500 }}>
                    {r.destination.name}
                  </Typography.Text>
                  <DestinationStatusTag status={r.destination.status} />
                  {r.download.subfolderPattern && (
                    <Typography.Text className="mv-mono mv-muted" ellipsis={{ tooltip: r.download.subfolderPattern }} style={{ display: 'block' }}>
                      …\{r.download.subfolderPattern}
                    </Typography.Text>
                  )}
                </div>
              ),
            },
            { title: 'Matches', align: 'right', width: 104, render: (_, r) => fmtNumber(r._count.matches) },
            { title: 'Version', align: 'center', width: 80, responsive: ['xxl'], render: (_, r) => <span className="mv-muted">v{r.currentVersion}</span> },
            {
              title: 'Enabled',
              align: 'right',
              width: 120,
              render: (_, r) => (
                <Space size={10}>
                  <Switch checked={r.enabled} disabled={!can('rules', 'edit')} loading={toggle.isPending && toggle.variables?.id === r.id} onChange={(enabled) =>
                      void confirm(
                        enabled
                          ? {
                              tone: 'success',
                              title: 'Enable this rule?',
                              subject: r.name,
                              description: 'Matching emails that arrive from now on will be processed by this rule.',
                              okText: 'Enable rule',
                              onConfirm: () => toggle.mutateAsync({ id: r.id, enabled }),
                            }
                          : {
                              tone: 'warning',
                              title: 'Disable this rule?',
                              subject: r.name,
                              description: 'New emails will no longer be checked against it. The rule and its history are kept, and you can enable it again any time.',
                              okText: 'Disable rule',
                              onConfirm: () => toggle.mutateAsync({ id: r.id, enabled }),
                            },
                      )
                    }
                  />
                  {can('rules', 'edit') && (
                    <Tooltip title="Edit rule">
                      <Button icon={<EditOutlined />} onClick={() => openEdit(r.id)} aria-label={`Edit ${r.name}`} />
                    </Tooltip>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

    </>
  );
}
