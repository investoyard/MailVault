import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, Descriptions, Row, Tag } from 'antd';
import { ApiOutlined, CloudServerOutlined, DatabaseOutlined, PoweroffOutlined, ReloadOutlined, SyncOutlined, WindowsOutlined } from '@ant-design/icons';
import { api } from '../api';
import { useAuth } from '../auth';
import { useConfirm } from '../components/confirm';
import { PageHeader, StatCard } from '../components/ui';
import { fmtDateTime, fromNow } from '../format';

interface Status {
  api: { ok: boolean; version: string; node: string; uptimeSec: number };
  database: { ok: boolean; size: string };
  workers: { instanceId: string; hostname: string; version: string; pid: number; memoryMb: number; startedAt: string; lastBeatAt: string; online: boolean }[];
  graphConfigured: boolean;
  certificate: { subject?: string; expires?: string; daysLeft?: number; error?: string } | null;
  notifications: { email: boolean; teams: boolean };
}

const uptime = (s: number) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`);

export function SystemStatusPage() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { message } = App.useApp();
  // Set while a restart is in progress: the time it was requested (ms).
  const [restartingSince, setRestartingSince] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ['system-status'],
    queryFn: () => api.get<Status>('/api/system/status'),
    refetchInterval: restartingSince ? 3_000 : 15_000,
  });
  const s = q.data;
  const worker = s?.workers.find((w) => w.online) ?? s?.workers[0];

  // The restart is done once a worker that started after the request is reporting in.
  useEffect(() => {
    if (!restartingSince || !s) return;
    if (s.workers.some((w) => w.online && new Date(w.startedAt).getTime() > restartingSince)) {
      setRestartingSince(null);
      message.success('Worker restarted. It is running with the latest settings.');
    } else if (Date.now() - restartingSince > 3 * 60_000) {
      setRestartingSince(null);
      message.warning('The worker has not come back yet. Check logs\\worker.log on the server, or the Processing log.');
    }
  }, [s, restartingSince, message]);

  const restartWorker = () =>
    confirm({
      tone: 'warning',
      icon: <PoweroffOutlined />,
      title: 'Restart the worker?',
      subject: worker ? `${worker.hostname} · PID ${worker.pid}` : undefined,
      description:
        'The worker finishes the downloads it is working on, stops, and starts again with the latest settings from .env. Mail processing pauses for about a minute; nothing is lost.',
      okText: 'Restart worker',
      onConfirm: async () => {
        try {
          const r = await api.post<{ requestedAt: number; message: string }>('/api/system/worker/restart');
          setRestartingSince(r.requestedAt);
          message.info(r.message);
        } catch (err) {
          message.error((err as Error).message);
          throw err;
        }
      },
    }).catch(() => undefined);

  const canRestart = can('settings', 'execute');

  return (
    <>
      <PageHeader
        title="System Status"
        subtitle="Health of the MailVault components on this server."
        extra={<Button icon={<ReloadOutlined />} onClick={() => q.refetch()} loading={q.isFetching}>Refresh</Button>}
      />

      {s && !worker?.online && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="The processing service (Worker) is not running"
          description="No emails are being processed. Start it with scripts\install-service.ps1, or run 'npm run dev:worker' during development."
        />
      )}
      {s && !s.graphConfigured && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="Microsoft 365 connection not configured yet"
          description="Register the Entra ID app and fill M365_TENANT_ID, M365_CLIENT_ID and M365_CERT_PATH in .env. See docs/ENTRA-SETUP.md."
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12} xl={6}>
          <StatCard label="Web API" value={s?.api.ok ? 'Online' : '—'} icon={<ApiOutlined />} tone="success" foot={s ? `Up ${uptime(s.api.uptimeSec)} · Node ${s.api.node}` : ' '} />
        </Col>
        <Col xs={24} md={12} xl={6}>
          <StatCard label="Processing service" value={worker?.online ? 'Running' : 'Offline'} icon={<CloudServerOutlined />} tone={worker?.online ? 'success' : 'error'} foot={worker ? `Heartbeat ${fromNow(worker.lastBeatAt)}` : 'Never started'} />
        </Col>
        <Col xs={24} md={12} xl={6}>
          <StatCard label="Database" value={s?.database.ok ? 'Connected' : '—'} icon={<DatabaseOutlined />} tone="success" foot={s ? `PostgreSQL · ${s.database.size}` : ' '} />
        </Col>
        <Col xs={24} md={12} xl={6}>
          <StatCard label="Microsoft 365" value={s?.graphConfigured ? 'Configured' : 'Not set up'} icon={<WindowsOutlined />} tone={s?.graphConfigured ? 'success' : 'warning'} foot="Microsoft Graph · Mail.Read" />
        </Col>
      </Row>

      <Card className="mv-card" title="Security & alerts" style={{ marginTop: 16 }}>
        <Descriptions size="small" bordered column={{ xs: 1, lg: 3 }}>
          <Descriptions.Item label="Microsoft 365 certificate">
            {!s?.certificate ? (
              <span className="mv-muted">Not configured</span>
            ) : s.certificate.error ? (
              <Tag color="red">{s.certificate.error}</Tag>
            ) : (
              <>
                <Tag color={(s.certificate.daysLeft ?? 0) <= 7 ? 'red' : (s.certificate.daysLeft ?? 0) <= 30 ? 'orange' : 'green'}>
                  {(s.certificate.daysLeft ?? 0) < 0 ? 'Expired' : `${s.certificate.daysLeft} days left`}
                </Tag>
                <span className="mv-muted">expires {fmtDateTime(s.certificate.expires)}</span>
              </>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Email alerts">{s?.notifications.email ? <Tag color="green">On</Tag> : <Tag>Off</Tag>}</Descriptions.Item>
          <Descriptions.Item label="Teams alerts">{s?.notifications.teams ? <Tag color="green">On</Tag> : <Tag>Off</Tag>}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card
        className="mv-card"
        title="Worker instances"
        style={{ marginTop: 16 }}
        extra={
          canRestart && (
            <Button
              icon={restartingSince ? <SyncOutlined spin /> : <PoweroffOutlined />}
              disabled={!!restartingSince || !worker?.online}
              title={!worker?.online ? 'The worker is not running' : undefined}
              onClick={restartWorker}
            >
              {restartingSince ? 'Restarting…' : 'Restart worker'}
            </Button>
          )
        }
      >
        {!s?.workers.length ? (
          <span className="mv-muted">No worker has reported in yet.</span>
        ) : (
          s.workers.map((w) => (
            <Descriptions key={w.instanceId} size="small" bordered column={{ xs: 1, md: 2, xl: 3 }} style={{ marginBottom: 12 }}>
              <Descriptions.Item label="Status">{w.online ? <Tag color="green">Running</Tag> : <Tag color="red">Not responding</Tag>}</Descriptions.Item>
              <Descriptions.Item label="Host">{w.hostname}</Descriptions.Item>
              <Descriptions.Item label="Version">v{w.version}</Descriptions.Item>
              <Descriptions.Item label="Started">{fmtDateTime(w.startedAt)}</Descriptions.Item>
              <Descriptions.Item label="Last heartbeat">{fmtDateTime(w.lastBeatAt)}</Descriptions.Item>
              <Descriptions.Item label="Memory">{w.memoryMb} MB (PID {w.pid})</Descriptions.Item>
            </Descriptions>
          ))
        )}
      </Card>
    </>
  );
}
