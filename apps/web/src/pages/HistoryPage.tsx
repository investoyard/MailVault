import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { App, Button, Card, DatePicker, Descriptions, Drawer, Input, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { CopyOutlined, DownloadOutlined, FileExcelOutlined, MailOutlined, ProfileOutlined, RedoOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { EmailDetailsModal } from '../components/EmailDetailsModal';
import { useAuth } from '../auth';
import type { Dayjs } from 'dayjs';
import { DOWNLOAD_STATUSES, DOWNLOAD_STATUS_LABELS, type DownloadStatus } from '@mailvault/shared';
import { api, qs } from '../api';
import { DownloadStatusTag, EmptyState, PageHeader } from '../components/ui';
import { fmtBytes, fmtDateTime, fmtNumber } from '../format';

interface Row {
  id: string;
  status: DownloadStatus;
  destinationPath: string | null;
  finalFileName: string | null;
  attempts: number;
  errorMessage: string | null;
  skipReason: string | null;
  downloadedAt: string | null;
  createdAt: string;
  sha256: string | null;
  extracted: { id: string; innerPath: string; fileName: string | null; status: DownloadStatus; reason: string | null; destinationPath: string | null; bytes: number | null }[];
  attachment: { name: string; sizeBytes: number; contentType: string | null };
  match: {
    correlationId: string;
    trigger: string;
    rule: { id: string; name: string };
    message: {
      fromEmail: string;
      fromName: string | null;
      toEmails: string[];
      ccEmails: string[];
      subject: string;
      receivedAt: string;
      mailbox: { id: string; email: string };
    };
  };
}

interface Resp {
  total: number;
  rows: Row[];
}

interface Filters {
  status?: DownloadStatus;
  mailboxId?: string;
  ruleId?: string;
  sender?: string;
  subject?: string;
  fileName?: string;
  range?: [Dayjs, Dayjs] | null;
}

export function HistoryPage() {
  const { message } = App.useApp();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [params] = useSearchParams();
  const initial: Filters = { status: (params.get('status') as DownloadStatus | null) ?? undefined };
  const [filters, setFilters] = useState<Filters>(initial);
  const [draft, setDraft] = useState<Filters>(initial);
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/api/history/${id}/retry`),
    onSuccess: () => {
      message.success('Queued. The file will be downloaded in a moment.');
      setSelected(null);
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['history'] }), 3000);
    },
    onError: (e: Error) => message.error(e.message),
  });
  const [selected, setSelected] = useState<Row | null>(null);

  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<{ id: string; email: string }[]>('/api/mailboxes') });
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api.get<{ id: string; name: string }[]>('/api/rules') });

  const q = useQuery({
    queryKey: ['history', page, pageSize, filters],
    queryFn: () => api.get<Resp>(`/api/history${filterQs(page, pageSize)}`),
    placeholderData: (prev) => prev,
  });

  function filterQs(p?: number, ps?: number) {
    return qs({
          page: p,
          pageSize: ps,
          status: filters.status,
          mailboxId: filters.mailboxId,
          ruleId: filters.ruleId,
          sender: filters.sender,
          subject: filters.subject,
          fileName: filters.fileName,
          from: filters.range?.[0]?.startOf('day').toISOString(),
          to: filters.range?.[1]?.endOf('day').toISOString(),
    });
  }

  const { can } = useAuth();
  const [picked, setPicked] = useState<string[]>([]);
  const [emailFor, setEmailFor] = useState<string | null>(null);
  const bulk = useMutation({
    mutationFn: (ids: string[]) => api.post<{ retried: number; skipped: number }>('/api/history/retry-bulk', { ids }),
    onSuccess: (r) => {
      message.success(`${r.retried} download(s) queued again${r.skipped ? `, ${r.skipped} skipped (not failed or waiting)` : ''}.`);
      setPicked([]);
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['history'] }), 3000);
    },
    onError: (e: Error) => message.error(e.message),
  });

  const apply = () => {
    setPage(1);
    setFilters(draft);
  };

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    message.success('Path copied. Paste it into File Explorer to open the folder.');
  };

  const folderOf = (p: string) => p.slice(0, p.lastIndexOf('\\'));

  return (
    <>
      <PageHeader
        title="Download History"
        subtitle="Every processed email and attachment, with its rule, destination and outcome."
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => q.refetch()} loading={q.isFetching}>
              Refresh
            </Button>
            {picked.length > 0 && can('history', 'execute') && (
              <Button icon={<RedoOutlined />} loading={bulk.isPending} onClick={() => bulk.mutate(picked)}>
                Retry {picked.length} selected
              </Button>
            )}
            <Tooltip title={`Exports all ${fmtNumber(q.data?.total)} records that match the current filters`}>
              <Button icon={<FileExcelOutlined />} href={`/api/history/export${filterQs()}`} disabled={!q.data?.total}>
                Export to Excel
              </Button>
            </Tooltip>
          </>
        }
      />

      <Card className="mv-card" style={{ marginBottom: 16 }} styles={{ body: { paddingBottom: 4 } }}>
        <div className="mv-filter-bar">
          <DatePicker.RangePicker value={draft.range ?? null} onChange={(v) => setDraft({ ...draft, range: v as [Dayjs, Dayjs] | null })} placeholder={['Received from', 'Received to']} />
          <Select allowClear placeholder="All mailboxes" style={{ width: 220 }} value={draft.mailboxId} onChange={(v) => setDraft({ ...draft, mailboxId: v })} options={(mailboxes.data ?? []).map((m) => ({ value: m.id, label: m.email }))} />
          <Select allowClear placeholder="All rules" style={{ width: 200 }} value={draft.ruleId} onChange={(v) => setDraft({ ...draft, ruleId: v })} options={(rules.data ?? []).map((r) => ({ value: r.id, label: r.name }))} />
          <Select allowClear placeholder="Any status" style={{ width: 190 }} value={draft.status} onChange={(v) => setDraft({ ...draft, status: v })} options={DOWNLOAD_STATUSES.map((s) => ({ value: s, label: DOWNLOAD_STATUS_LABELS[s] }))} />
          <Input allowClear placeholder="Sender" style={{ width: 190 }} value={draft.sender} onChange={(e) => setDraft({ ...draft, sender: e.target.value })} onPressEnter={apply} />
          <Input allowClear placeholder="Subject" style={{ width: 190 }} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} onPressEnter={apply} />
          <Input allowClear placeholder="File name" style={{ width: 170 }} value={draft.fileName} onChange={(e) => setDraft({ ...draft, fileName: e.target.value })} onPressEnter={apply} />
          <Space>
            <Button type="primary" icon={<SearchOutlined />} onClick={apply}>
              Apply
            </Button>
            <Button onClick={() => { setDraft({}); setFilters({}); setPage(1); }}>Reset</Button>
          </Space>
        </div>
      </Card>

      <Card className="mv-card" styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          loading={q.isFetching}
          dataSource={q.data?.rows ?? []}
          onRow={(r) => ({ onClick: () => setSelected(r), style: { cursor: 'pointer' } })}
          rowSelection={
            can('history', 'execute')
              ? {
                  selectedRowKeys: picked,
                  onChange: (k) => setPicked(k as string[]),
                  getCheckboxProps: (r) => ({ disabled: !['FAILED', 'WAITING_DESTINATION', 'RETRYING'].includes(r.status) }),
                }
              : undefined
          }
          scroll={{ x: 1100 }}
          locale={{ emptyText: <EmptyState title="No history found" description="Try a wider date range or clear the filters." /> }}
          pagination={{
            current: page,
            pageSize,
            total: q.data?.total ?? 0,
            showSizeChanger: true,
            showTotal: (t) => `${fmtNumber(t)} records`,
            onChange: (p, s) => {
              setPage(p);
              setPageSize(s);
            },
          }}
          columns={[
            {
              title: 'Attachment',
              fixed: 'left',
              width: 260,
              render: (_, r) => (
                <div>
                  <Typography.Text strong ellipsis style={{ display: 'block', maxWidth: 240 }}>
                    {r.finalFileName ?? r.attachment.name}
                  </Typography.Text>
                  <span className="mv-muted" style={{ fontSize: 12.5 }}>{fmtBytes(r.attachment.sizeBytes)}</span>
                  {r.extracted.length > 0 && (
                    <Tag style={{ marginLeft: 6 }} color="purple">
                      {r.extracted.filter((x) => x.status === 'SUCCESS').length} of {r.extracted.length} inside saved
                    </Tag>
                  )}
                </div>
              ),
            },
            {
              title: 'Email',
              width: 300,
              render: (_, r) => (
                <div>
                  <Typography.Text ellipsis style={{ display: 'block', maxWidth: 280 }}>{r.match.message.subject}</Typography.Text>
                  <span className="mv-muted" style={{ fontSize: 12.5 }}>{r.match.message.fromEmail}</span>
                </div>
              ),
            },
            { title: 'Received', width: 160, render: (_, r) => fmtDateTime(r.match.message.receivedAt) },
            { title: 'Rule', width: 170, render: (_, r) => r.match.rule.name },
            { title: 'Mailbox', width: 200, render: (_, r) => <span className="mv-muted">{r.match.message.mailbox.email}</span> },
            {
              title: 'Status',
              width: 170,
              render: (_, r) => {
                const note = r.errorMessage ?? r.skipReason;
                return note ? <Tooltip title={note}><span><DownloadStatusTag status={r.status} /></span></Tooltip> : <DownloadStatusTag status={r.status} />;
              },
            },
            { title: 'Downloaded', width: 160, render: (_, r) => fmtDateTime(r.downloadedAt) },
          ]}
        />
      </Card>

      <Drawer
        open={!!selected}
        onClose={() => setSelected(null)}
        width={620}
        title={selected?.finalFileName ?? selected?.attachment.name}
        extra={selected && <DownloadStatusTag status={selected.status} />}
      >
        {selected && (
          <>
            {(selected.errorMessage || selected.skipReason) && (
              <Card size="small" style={{ marginBottom: 16, background: selected.status === 'FAILED' ? '#FEF2F2' : '#F8FAFC', borderColor: 'transparent' }}>
                <b>{selected.status === 'FAILED' ? 'Error' : 'Reason'}:</b> {selected.errorMessage ?? selected.skipReason}
              </Card>
            )}

            <Typography.Title level={5}>Email</Typography.Title>
            <Descriptions column={1} size="small" bordered style={{ marginBottom: 20 }} styles={{ label: { width: 150 } }}>
              <Descriptions.Item label="Subject">{selected.match.message.subject}</Descriptions.Item>
              <Descriptions.Item label="From">{selected.match.message.fromName ? `${selected.match.message.fromName} <${selected.match.message.fromEmail}>` : selected.match.message.fromEmail}</Descriptions.Item>
              <Descriptions.Item label="To">{selected.match.message.toEmails.join(', ') || '—'}</Descriptions.Item>
              {selected.match.message.ccEmails.length > 0 && <Descriptions.Item label="CC">{selected.match.message.ccEmails.join(', ')}</Descriptions.Item>}
              <Descriptions.Item label="Received">{fmtDateTime(selected.match.message.receivedAt)}</Descriptions.Item>
              <Descriptions.Item label="Mailbox">{selected.match.message.mailbox.email}</Descriptions.Item>
            </Descriptions>

            {selected.extracted.length > 0 && (
              <>
                <Typography.Title level={5}>Files inside ({selected.extracted.length})</Typography.Title>
                <Table
                  size="small"
                  rowKey="id"
                  pagination={selected.extracted.length > 10 ? { pageSize: 10, size: 'small' } : false}
                  style={{ marginBottom: 20 }}
                  dataSource={selected.extracted}
                  columns={[
                    {
                      title: 'File',
                      render: (_, x) => (
                        <div>
                          <div style={{ fontWeight: 500 }}>{x.fileName ?? x.innerPath.split(/[\\/]/).pop()}</div>
                          {x.innerPath !== x.fileName && <div className="mv-muted mv-mono" style={{ fontSize: 11.5 }}>{x.innerPath}</div>}
                        </div>
                      ),
                    },
                    { title: 'Result', width: 210, render: (_, x) => (x.reason ? <Tooltip title={x.reason}><span><DownloadStatusTag status={x.status} /></span></Tooltip> : <DownloadStatusTag status={x.status} />) },
                    {
                      title: '',
                      width: 44,
                      render: (_, x) =>
                        x.destinationPath && (
                          <Tooltip title={`Copy path: ${x.destinationPath}`}>
                            <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => copy(x.destinationPath!)} />
                          </Tooltip>
                        ),
                    },
                  ]}
                />
              </>
            )}

            <Typography.Title level={5}>Attachment</Typography.Title>
            <Descriptions column={1} size="small" bordered style={{ marginBottom: 20 }} styles={{ label: { width: 150 } }}>
              <Descriptions.Item label="Original name">{selected.attachment.name}</Descriptions.Item>
              <Descriptions.Item label="Saved as">{selected.finalFileName ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Size">{fmtBytes(selected.attachment.sizeBytes)}</Descriptions.Item>
              <Descriptions.Item label="Type">{selected.attachment.contentType ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Rule">{selected.match.rule.name} <Tag style={{ marginLeft: 6 }}>{selected.match.trigger}</Tag></Descriptions.Item>
              <Descriptions.Item label="Attempts">{selected.attempts}</Descriptions.Item>
              <Descriptions.Item label="Downloaded">{fmtDateTime(selected.downloadedAt)}</Descriptions.Item>
              <Descriptions.Item label="Destination">
                {selected.destinationPath ? (
                  <Space direction="vertical" size={4}>
                    <span className="mv-mono">{selected.destinationPath}</span>
                    <Button size="small" icon={<CopyOutlined />} onClick={() => copy(folderOf(selected.destinationPath!))}>
                      Copy folder path
                    </Button>
                  </Space>
                ) : (
                  '—'
                )}
              </Descriptions.Item>
              {selected.sha256 && <Descriptions.Item label="SHA-256"><span className="mv-mono" style={{ wordBreak: 'break-all' }}>{selected.sha256}</span></Descriptions.Item>}
            </Descriptions>

            <Space wrap>
              <Button icon={<MailOutlined />} onClick={() => setEmailFor(selected.id)}>
                View email
              </Button>
              {selected.status === 'SUCCESS' && can('history', 'execute') && (
                <Button icon={<DownloadOutlined />} href={`/api/history/${selected.id}/file`}>
                  Save a copy
                </Button>
              )}
              {['FAILED', 'WAITING_DESTINATION', 'RETRYING'].includes(selected.status) && (
                <Button type="primary" icon={<RedoOutlined />} loading={retry.isPending} onClick={() => retry.mutate(selected.id)}>
                  Retry now
                </Button>
              )}
              {selected.status === 'AWAITING_MANUAL' && (
                <Button type="primary" icon={<DownloadOutlined />} loading={retry.isPending} onClick={() => retry.mutate(selected.id)}>
                  Download to folder
                </Button>
              )}
              <Tooltip title={`Trace ID ${selected.match.correlationId}`}>
                <Button icon={<ProfileOutlined />} href={`/logs?correlationId=${selected.match.correlationId}`}>
                  Processing logs
                </Button>
              </Tooltip>
            </Space>
          </>
        )}
      </Drawer>

      <EmailDetailsModal downloadId={emailFor} onClose={() => setEmailFor(null)} />
    </>
  );
}
