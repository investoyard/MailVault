import { useQuery } from '@tanstack/react-query';
import { Alert, Descriptions, Modal, Skeleton, Tag, Typography } from 'antd';
import { PaperClipOutlined } from '@ant-design/icons';
import { api } from '../api';
import { fmtBytes, fmtDateTime } from '../format';

interface EmailDetails {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  receivedAt: string;
  mailbox: string;
  internetMessageId: string | null;
  attachments: { name: string; sizeBytes: number; isInline: boolean; kind: string }[];
  rulesApplied: { rule: string; trigger: string; runNumber: number; at: string }[];
  body: string | null;
  bodyError: string | null;
}

/** Email details: stored metadata plus the body read live from the mailbox (bodies are never stored). */
export function EmailDetailsModal({ downloadId, onClose }: { downloadId: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['email-details', downloadId],
    queryFn: () => api.get<EmailDetails>(`/api/history/${downloadId}/email`),
    enabled: !!downloadId,
  });
  const d = q.data;

  return (
    <Modal open={!!downloadId} onCancel={onClose} footer={null} width={760} title={d?.subject ?? 'Email details'} destroyOnHidden>
      {q.isLoading || !d ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : (
        <>
          <Descriptions size="small" column={1} bordered styles={{ label: { width: 130 } }} style={{ marginBottom: 16 }}>
            <Descriptions.Item label="From">{d.from}</Descriptions.Item>
            <Descriptions.Item label="To">{d.to.join(', ') || '—'}</Descriptions.Item>
            {d.cc.length > 0 && <Descriptions.Item label="CC">{d.cc.join(', ')}</Descriptions.Item>}
            <Descriptions.Item label="Received">{fmtDateTime(d.receivedAt)}</Descriptions.Item>
            <Descriptions.Item label="Mailbox">{d.mailbox}</Descriptions.Item>
            <Descriptions.Item label="Attachments">
              {d.attachments.length
                ? d.attachments.map((a) => (
                    <Tag key={a.name} icon={<PaperClipOutlined />} style={{ marginBottom: 4 }}>
                      {a.name} · {fmtBytes(a.sizeBytes)}
                      {a.isInline ? ' · inline' : ''}
                    </Tag>
                  ))
                : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Rules applied">
              {d.rulesApplied.map((r) => (
                <div key={`${r.rule}-${r.runNumber}`}>
                  {r.rule} <Tag>{r.trigger}</Tag>
                  {r.runNumber > 1 && <Tag color="blue">run {r.runNumber}</Tag>}
                  <span className="mv-muted">{fmtDateTime(r.at)}</span>
                </div>
              ))}
            </Descriptions.Item>
          </Descriptions>
          <Typography.Title level={5}>Message</Typography.Title>
          {d.bodyError ? (
            <Alert type="info" showIcon message={d.bodyError} />
          ) : (
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: '#F8FAFC', border: '1px solid #E6E9F0', borderRadius: 8, padding: 14, maxHeight: 360, overflow: 'auto', margin: 0 }}>
              {d.body || '(empty message)'}
            </pre>
          )}
        </>
      )}
    </Modal>
  );
}
