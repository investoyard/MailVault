import type { ReactNode } from 'react';
import { Empty, Tag, Tooltip } from 'antd';
import {
  CheckCircleFilled,
  ClockCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  MinusCircleFilled,
  PauseCircleFilled,
  SyncOutlined,
} from '@ant-design/icons';
import {
  DOWNLOAD_STATUS_LABELS,
  MAILBOX_STATUS_LABELS,
  type DestinationStatus,
  type DownloadStatus,
  type MailboxStatus,
} from '@mailvault/shared';
import { palette } from '../theme';

export function PageHeader({ title, subtitle, extra }: { title: string; subtitle?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="mv-page-header">
      <div>
        <h1 className="mv-page-title">{title}</h1>
        {subtitle && <div className="mv-page-subtitle">{subtitle}</div>}
      </div>
      {extra && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{extra}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  icon,
  tone = 'primary',
  foot,
}: {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  tone?: 'primary' | 'success' | 'error' | 'warning' | 'info' | 'neutral';
  foot?: ReactNode;
}) {
  const tones = {
    primary: [palette.primary, palette.primarySoft],
    success: [palette.success, palette.successSoft],
    error: [palette.error, palette.errorSoft],
    warning: [palette.warning, palette.warningSoft],
    info: [palette.info, palette.infoSoft],
    neutral: ['#475569', palette.neutralSoft],
  } as const;
  const [fg, bg] = tones[tone];
  return (
    <div className="mv-stat">
      <div className="mv-stat-top">
        <span className="mv-stat-label">{label}</span>
        <span className="mv-stat-icon" style={{ color: fg, background: bg }}>
          {icon}
        </span>
      </div>
      <div className="mv-stat-value">{value}</div>
      {foot && <div className="mv-stat-foot">{foot}</div>}
    </div>
  );
}

const soft = (color: string, bg: string) => ({ color, background: bg, borderColor: 'transparent', fontWeight: 500 });

export function DownloadStatusTag({ status }: { status: DownloadStatus }) {
  const map: Record<DownloadStatus, { style: object; icon: ReactNode }> = {
    SUCCESS: { style: soft(palette.success, palette.successSoft), icon: <CheckCircleFilled /> },
    FAILED: { style: soft(palette.error, palette.errorSoft), icon: <CloseCircleFilled /> },
    SKIPPED: { style: soft('#475569', palette.neutralSoft), icon: <MinusCircleFilled /> },
    PENDING: { style: soft(palette.info, palette.infoSoft), icon: <ClockCircleFilled /> },
    IN_PROGRESS: { style: soft(palette.primary, palette.primarySoft), icon: <SyncOutlined spin /> },
    RETRYING: { style: soft(palette.warning, palette.warningSoft), icon: <SyncOutlined /> },
    WAITING_DESTINATION: { style: soft(palette.warning, palette.warningSoft), icon: <PauseCircleFilled /> },
    AWAITING_MANUAL: { style: soft(palette.primary, palette.primarySoft), icon: <ClockCircleFilled /> },
  };
  const m = map[status];
  return (
    <Tag style={m.style} icon={m.icon}>
      {DOWNLOAD_STATUS_LABELS[status]}
    </Tag>
  );
}

const MAILBOX_COLORS: Record<MailboxStatus, [string, string]> = {
  CONNECTED: [palette.success, palette.successSoft],
  SYNCING: [palette.primary, palette.primarySoft],
  WARNING: [palette.warning, palette.warningSoft],
  REAUTH_REQUIRED: [palette.error, palette.errorSoft],
  DISCONNECTED: [palette.error, palette.errorSoft],
  DISABLED: ['#64748B', palette.neutralSoft],
  PENDING_SETUP: [palette.info, palette.infoSoft],
};

export function MailboxStatusTag({ status, error }: { status: MailboxStatus; error?: string | null }) {
  const [fg, bg] = MAILBOX_COLORS[status];
  const tag = (
    <Tag style={soft(fg, bg)}>
      <span className="mv-dot" style={{ background: fg, marginRight: 6, verticalAlign: 1 }} />
      {MAILBOX_STATUS_LABELS[status]}
    </Tag>
  );
  return error ? <Tooltip title={error}>{tag}</Tooltip> : tag;
}

export function mailboxColor(status: MailboxStatus) {
  return MAILBOX_COLORS[status][0];
}

const DEST: Record<DestinationStatus, { label: string; c: [string, string]; icon: ReactNode }> = {
  HEALTHY: { label: 'Healthy', c: [palette.success, palette.successSoft], icon: <CheckCircleFilled /> },
  LOW_SPACE: { label: 'Low space', c: [palette.warning, palette.warningSoft], icon: <ExclamationCircleFilled /> },
  UNAVAILABLE: { label: 'Unavailable', c: [palette.error, palette.errorSoft], icon: <CloseCircleFilled /> },
  UNKNOWN: { label: 'Not checked', c: ['#64748B', palette.neutralSoft], icon: <ClockCircleFilled /> },
};

export function DestinationStatusTag({ status, error }: { status: DestinationStatus; error?: string | null }) {
  const d = DEST[status];
  const tag = (
    <Tag style={soft(d.c[0], d.c[1])} icon={d.icon}>
      {d.label}
    </Tag>
  );
  return error ? <Tooltip title={error}>{tag}</Tooltip> : tag;
}

export function destinationColor(status: DestinationStatus) {
  return DEST[status].c[0];
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      style={{ padding: '28px 0' }}
      description={
        <div>
          <div style={{ fontWeight: 600, color: palette.text, marginBottom: 4 }}>{title}</div>
          {description && <div className="mv-muted" style={{ maxWidth: 380, margin: '0 auto' }}>{description}</div>}
        </div>
      }
    >
      {action}
    </Empty>
  );
}
