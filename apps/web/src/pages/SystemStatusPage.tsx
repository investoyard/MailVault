import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Descriptions, Row, Tag } from 'antd';
import { ApiOutlined, CloudServerOutlined, DatabaseOutlined, ReloadOutlined, WindowsOutlined } from '@ant-design/icons';
import { api } from '../api';
import { PageHeader, StatCard } from '../components/ui';
import { fmtDateTime, fromNow } from '../format';

interface Status {
  api: { ok: boolean; version: string; node: string; uptimeSec: number };
  database: { ok: boolean; size: string };
  workers: { instanceId: string; hostname: string; version: string; pid: number; memoryMb: number; startedAt: string; lastBeatAt: string; online: boolean }[];
  graphConfigured: boolean;
}

const uptime = (s: number) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`);

export function SystemStatusPage() {
  const q = useQuery({ queryKey: ['system-status'], queryFn: () => api.get<Status>('/api/system/status'), refetchInterval: 15_000 });
  const s = q.data;
  const worker = s?.workers.find((w) => w.online) ?? s?.workers[0];

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

      <Card className="mv-card" title="Worker instances" style={{ marginTop: 16 }}>
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
