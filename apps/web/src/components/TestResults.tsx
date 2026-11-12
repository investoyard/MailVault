import { useState } from 'react';
import { App, Button, Card, Checkbox, Collapse, Empty, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, DownloadOutlined, HistoryOutlined, PaperClipOutlined } from '@ant-design/icons';
import { api } from '../api';
import { fmtBytes, fmtDateTime } from '../format';
import { palette } from '../theme';

export interface TestEmail {
  providerMessageId: string;
  from: { email: string; name?: string };
  to: { email: string }[];
  cc: { email: string }[];
  subject: string;
  receivedAt: string;
  attachments: { id: string; name: string; size: number; isInline: boolean; kind: string }[];
  rules: {
    ruleId: string;
    name: string;
    enabled: boolean;
    priority: number;
    matched: boolean;
    checks: { condition: string; passed: boolean; detail: string }[];
    decisions: { attachmentId: string; include: boolean; reason: string | null; saveName: string }[];
    processed: { runs: number; lastAt: string } | null;
  }[];
}

function Check({ ok }: { ok: boolean }) {
  return ok ? <CheckCircleFilled style={{ color: palette.success }} /> : <CloseCircleFilled style={{ color: palette.error }} />;
}

function EmailCard({ email, mailboxId, canDownload }: { email: TestEmail; mailboxId: string; canDownload: boolean }) {
  const { message } = App.useApp();
  const matched = email.rules.filter((r) => r.matched);
  const savedRules = email.rules.filter((r) => r.ruleId !== 'draft');
  const [selected, setSelected] = useState<string[]>([]);
  const [ruleId, setRuleId] = useState<string | undefined>(matched.find((r) => r.ruleId !== 'draft')?.ruleId ?? savedRules[0]?.ruleId);
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ message: string }>('/api/rule-testing/download', { mailboxId, providerMessageId: email.providerMessageId, ruleId, attachmentIds: selected });
      message.success(r.message);
      setSelected([]);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mv-card" size="small" style={{ marginBottom: 12 }} styles={{ body: { padding: 16 } }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Typography.Text strong style={{ fontSize: 15 }}>{email.subject || '(no subject)'}</Typography.Text>
          <div className="mv-muted" style={{ fontSize: 13 }}>
            {email.from.name ? `${email.from.name} <${email.from.email}>` : email.from.email} · {fmtDateTime(email.receivedAt)}
          </div>
        </div>
        <Space wrap>
          {matched.length ? (
            matched.map((r) => (
              <Tag key={r.ruleId} color={r.ruleId === 'draft' ? 'purple' : 'green'} icon={<CheckCircleFilled />}>
                {r.name}
              </Tag>
            ))
          ) : (
            <Tag>No rule matches</Tag>
          )}
        </Space>
      </div>

      {email.attachments.length > 0 && (
        <div style={{ marginTop: 12, padding: 12, background: '#F8FAFC', borderRadius: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            <PaperClipOutlined /> Attachments
          </div>
          <Checkbox.Group value={selected} onChange={(v) => setSelected(v as string[])} style={{ display: 'flex', flexDirection: 'column', gap: 4 }} disabled={!canDownload}>
            {email.attachments.map((a) => (
              <Checkbox key={a.id} value={a.id} disabled={a.kind === 'reference'}>
                {a.name} <span className="mv-muted">· {fmtBytes(a.size)}</span>
                {a.isInline && <Tag style={{ marginLeft: 6 }}>inline</Tag>}
                {a.kind === 'reference' && <Tag style={{ marginLeft: 6 }}>cloud link</Tag>}
              </Checkbox>
            ))}
          </Checkbox.Group>
          {canDownload && savedRules.length > 0 && (
            <Space style={{ marginTop: 10 }} wrap>
              <span className="mv-muted" style={{ fontSize: 13 }}>Save selected using the folder of</span>
              <Select size="small" style={{ minWidth: 220 }} value={ruleId} onChange={setRuleId} options={savedRules.map((r) => ({ value: r.ruleId, label: r.name }))} />
              <Button size="small" type="primary" icon={<DownloadOutlined />} disabled={!selected.length || !ruleId} loading={busy} onClick={download}>
                Download {selected.length || ''} file{selected.length === 1 ? '' : 's'}
              </Button>
            </Space>
          )}
        </div>
      )}

      <Collapse
        ghost
        size="small"
        style={{ marginTop: 8 }}
        items={[
          {
            key: 'why',
            label: <span className="mv-muted">Why each rule did or didn't match ({email.rules.length})</span>,
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {email.rules.map((r) => (
                  <div key={r.ruleId} style={{ borderLeft: `3px solid ${r.matched ? palette.success : '#E2E8F0'}`, paddingLeft: 12 }}>
                    <Space size={6} wrap>
                      <Check ok={r.matched} />
                      <b>{r.name}</b>
                      <Tag>#{r.priority}</Tag>
                      {!r.enabled && <Tag>disabled</Tag>}
                      {r.processed && (
                        <Tooltip title={`Last on ${fmtDateTime(r.processed.lastAt)}`}>
                          <Tag icon={<HistoryOutlined />} color="blue">
                            Already processed{r.processed.runs > 1 ? ` ×${r.processed.runs}` : ''}
                          </Tag>
                        </Tooltip>
                      )}
                    </Space>
                    <div style={{ marginTop: 4 }}>
                      {r.checks.length === 0 ? (
                        <span className="mv-muted" style={{ fontSize: 13 }}>No conditions: every email matches.</span>
                      ) : (
                        r.checks.map((c) => (
                          <div key={c.condition} style={{ fontSize: 13 }}>
                            <Check ok={c.passed} /> <b>{c.condition}:</b> <span className="mv-muted">{c.detail}</span>
                          </div>
                        ))
                      )}
                    </div>
                    {r.matched && r.decisions.length > 0 && (
                      <div style={{ marginTop: 6, fontSize: 13 }}>
                        {r.decisions.map((d) => (
                          <div key={d.attachmentId}>
                            <PaperClipOutlined /> {d.saveName}:{' '}
                            {d.include ? <span style={{ color: palette.success }}>would be saved</span> : <span className="mv-muted">skipped, {d.reason}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ),
          },
        ]}
      />
    </Card>
  );
}

export function TestResults({ emails, mailboxId, canDownload = true }: { emails: TestEmail[]; mailboxId: string; canDownload?: boolean }) {
  if (!emails.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No emails found for these filters" />;
  return (
    <>
      {emails.map((e) => (
        <EmailCard key={e.providerMessageId} email={e} mailboxId={mailboxId} canDownload={canDownload} />
      ))}
    </>
  );
}
