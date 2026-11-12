import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, Form, Input, InputNumber, Row, Select, Skeleton, Space, Switch } from 'antd';
import { SaveOutlined, SendOutlined } from '@ant-design/icons';
import { DEFAULT_BLOCKED_EXTENSIONS } from '@mailvault/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { PageHeader } from '../components/ui';

type Settings = Record<string, unknown>;

// Form field names can't contain dots, so map "sync.intervalMinutes" <-> "sync__intervalMinutes".
const toForm = (s: Settings) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k.replace(/\./g, '__'), v]));
const fromForm = (f: Settings) =>
  Object.fromEntries(
    Object.entries(f).map(([k, v]) => [
      k.replace(/__/g, '.'),
      k === 'retry__intervalsMinutes' && Array.isArray(v) ? v.map(Number).filter((n) => n > 0) : v,
    ]),
  );

const TIME_ZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'UTC', 'America/New_York'];

export function SettingsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const canEdit = can('settings', 'edit');

  useEffect(() => {
    if (q.data) form.setFieldsValue(toForm(q.data));
  }, [q.data, form]);

  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const sendTest = async () => {
    setTesting(true);
    try {
      const smtp = form.getFieldValue("notifications__smtp");
      const r = await api.post<{ message: string }>("/api/settings/test-email", { to: testTo.trim(), smtp: { enabled: true, port: 587, secure: false, user: "", ...smtp } });
      message.success(r.message);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const save = useMutation({
    mutationFn: (v: Settings) => api.put<{ ok?: boolean; error?: string }>('/api/settings', fromForm(v)),
    onSuccess: (r) => {
      if (r.error) return message.error(r.error);
      message.success('Settings saved');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  if (q.isLoading) return <Skeleton active />;

  const section = (title: string, desc: string, children: React.ReactNode) => (
    <Card className="mv-card" style={{ marginBottom: 16 }}>
      <Row gutter={32}>
        <Col xs={24} lg={7}>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{title}</div>
          <div className="mv-muted" style={{ marginBottom: 16 }}>{desc}</div>
        </Col>
        <Col xs={24} lg={17}>{children}</Col>
      </Row>
    </Card>
  );

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="System-wide defaults. Individual mailboxes and rules can override some of them."
        extra={
          canEdit && (
            <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={() => form.submit()}>
              Save changes
            </Button>
          )
        }
      />
      <Form form={form} layout="vertical" disabled={!canEdit} onFinish={(v) => save.mutate(v)}>
        {section(
          'Email monitoring',
          'How often mailboxes are checked and where processing starts.',
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="sync__intervalMinutes" label="Check mailboxes every (minutes)">
                <InputNumber min={1} max={1440} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="general__initialLookbackDays" label="When a mailbox is added, also process the last (days)" tooltip="0 = only new emails. Older emails need a historical job.">
                <InputNumber min={0} max={365} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="general__businessTimeZone" label="Business time zone" tooltip="Used for date folders and 'today' on the dashboard.">
                <Select showSearch options={TIME_ZONES.map((t) => ({ value: t, label: t }))} />
              </Form.Item>
            </Col>
          </Row>,
        )}

        {section(
          'Retries',
          'Temporary problems (throttling, network, locked files) are retried automatically.',
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="retry__maxAttempts" label="Maximum attempts">
                <InputNumber min={0} max={20} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="retry__intervalsMinutes" label="Wait between attempts (minutes)" tooltip="Each retry waits longer: e.g. 1, 5, 15, 60">
                <Select mode="tags" tokenSeparators={[',', ' ']} />
              </Form.Item>
            </Col>
          </Row>,
        )}

        {section(
          'Attachments & files',
          'Limits and defaults that apply to every rule.',
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="attachments__maxSizeMb" label="Maximum attachment size (MB)">
                <InputNumber min={1} max={150} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="files__defaultDuplicatePolicy" label="Default duplicate handling">
                <Select
                  options={[
                    { value: 'SMART', label: 'Smart: skip identical files, rename different ones' },
                    { value: 'SKIP', label: 'Skip duplicate' },
                    { value: 'REPLACE', label: 'Replace existing file' },
                    { value: 'RENAME', label: 'Rename automatically' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col xs={24}>
              <Form.Item name="attachments__blockedExtensions" label="Blocked file types (never downloaded)" extra={`Recommended: ${DEFAULT_BLOCKED_EXTENSIONS.slice(0, 8).join(', ')}…`}>
                <Select mode="tags" tokenSeparators={[',', ' ']} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="attachments__includeInline" label="Include inline images (e.g. signature logos)" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>,
        )}

        {section(
          'Logs & retention',
          'How long records are kept. Cleanup runs nightly and is itself audited.',
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item name="logs__retentionDays" label="Keep logs (days)">
                <InputNumber min={7} max={3650} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="history__retentionDays" label="Keep download history (days)">
                <InputNumber min={30} max={3650} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="logs__autoCleanup" label="Automatic cleanup" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>,
        )}

        {section(
          'Email alerts (SMTP)',
          'In-app alerts are always on. Email goes to each user’s address, following their own preferences (instant or daily summary).',
          <>
            <Row gutter={16}>
              <Col xs={24}>
                <Form.Item name={['notifications__smtp', 'enabled']} label="Send alert emails" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name={['notifications__smtp', 'host']} label="SMTP server">
                  <Input placeholder="smtp.office365.com or your mail relay" />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item name={['notifications__smtp', 'port']} label="Port">
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item name={['notifications__smtp', 'secure']} label="SSL/TLS on connect" valuePropName="checked" tooltip="On for port 465. Port 587 uses STARTTLS automatically.">
                  <Switch />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name={['notifications__smtp', 'user']} label="Username" tooltip="Leave empty for an internal relay without sign-in. The password goes in .env as SMTP_PASSWORD.">
                  <Input placeholder="mailvault@company.com" autoComplete="off" />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name={['notifications__smtp', 'from']} label="From address">
                  <Input placeholder="MailVault <mailvault@company.com>" />
                </Form.Item>
              </Col>
            </Row>
            <Space.Compact style={{ width: '100%', maxWidth: 520 }}>
              <Input placeholder="Send a test email to…" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
              <Button icon={<SendOutlined />} loading={testing} onClick={sendTest} disabled={!testTo}>
                Send test
              </Button>
            </Space.Compact>
          </>,
        )}

        {section(
          'Microsoft Teams',
          'Posts warnings, errors and recoveries to a Teams channel.',
          <>
            <Form.Item name="notifications__teams__enabled" label="Post alerts to Teams" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Alert
              type="info"
              showIcon
              message="One-time setup"
              description="In the Teams channel: ⋯ → Workflows → “Post to a channel when a webhook request is received”. Copy the URL into .env as TEAMS_WEBHOOK_URL and restart MailVault."
            />
          </>,
        )}
      </Form>
    </>
  );
}
