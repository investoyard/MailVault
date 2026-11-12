import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, List, Segmented, Tag } from 'antd';
import { CheckCircleFilled, CheckOutlined, CloseCircleFilled, ExclamationCircleFilled, InfoCircleFilled } from '@ant-design/icons';
import type { AlertSeverity } from '@mailvault/shared';
import { api } from '../api';
import { EmptyState, PageHeader } from '../components/ui';
import { fmtDateTime, fromNow } from '../format';
import { palette } from '../theme';

interface Note {
  id: string;
  type: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  link: string | null;
  resolvedAt: string | null;
  createdAt: string;
  readAt: string | null;
}

const ICON: Record<AlertSeverity, [React.ReactNode, string, string]> = {
  ERROR: [<CloseCircleFilled key="e" />, palette.error, palette.errorSoft],
  WARNING: [<ExclamationCircleFilled key="w" />, palette.warning, palette.warningSoft],
  SUCCESS: [<CheckCircleFilled key="s" />, palette.success, palette.successSoft],
  INFO: [<InfoCircleFilled key="i" />, palette.info, palette.infoSoft],
};

export function NotificationsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'unread' | 'open'>('all');
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<Note[]>('/api/notifications') });
  const readAll = useMutation({
    mutationFn: () => api.post('/api/notifications/read-all'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const rows = (q.data ?? []).filter((n) =>
    filter === 'unread' ? !n.readAt : filter === 'open' ? (n.severity === 'ERROR' || n.severity === 'WARNING') && !n.resolvedAt : true,
  );
  const unread = (q.data ?? []).filter((n) => !n.readAt).length;

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="Alerts about mailboxes, folders, failures and the processing service. Repeated problems raise one alert until resolved."
        extra={
          <Button icon={<CheckOutlined />} disabled={!unread} loading={readAll.isPending} onClick={() => readAll.mutate()}>
            Mark all as read
          </Button>
        }
      />
      <Card
        className="mv-card"
        title={
          <Segmented
            value={filter}
            onChange={(v) => setFilter(v as typeof filter)}
            options={[
              { label: 'All', value: 'all' },
              { label: `Unread (${unread})`, value: 'unread' },
              { label: 'Open problems', value: 'open' },
            ]}
          />
        }
      >
        <List
          loading={q.isLoading}
          dataSource={rows}
          locale={{ emptyText: <EmptyState title="You're all caught up" description="New alerts will appear here." /> }}
          renderItem={(n) => {
            const [icon, fg, bg] = ICON[n.severity];
            return (
              <List.Item
                style={{ cursor: n.link ? 'pointer' : 'default', background: n.readAt ? undefined : '#FAF9FD', paddingInline: 12, borderRadius: 8 }}
                onClick={() => n.link && navigate(n.link)}
                extra={<span className="mv-muted" title={fmtDateTime(n.createdAt)}>{fromNow(n.createdAt)}</span>}
              >
                <List.Item.Meta
                  avatar={<div style={{ width: 36, height: 36, borderRadius: 10, background: bg, color: fg, display: 'grid', placeItems: 'center', fontSize: 16 }}>{icon}</div>}
                  title={
                    <span>
                      {n.title}
                      {!n.readAt && <span className="mv-dot" style={{ background: palette.primary, marginLeft: 8, verticalAlign: 2 }} />}
                      {n.resolvedAt && <Tag color="green" style={{ marginLeft: 8 }}>Resolved</Tag>}
                    </span>
                  }
                  description={n.message}
                />
              </List.Item>
            );
          }}
        />
      </Card>
    </>
  );
}
