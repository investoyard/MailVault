import { useState } from 'react';
import { Alert, Button, Divider, Form, Input, Tooltip, Typography } from 'antd';
import {
  FieldTimeOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
  WindowsFilled,
} from '@ant-design/icons';
import { useAuth } from '../auth';

const FEATURES = [
  { icon: <FieldTimeOutlined />, title: 'Hands-free collection', text: 'Watches Microsoft 365 mailboxes and saves matching attachments automatically.' },
  { icon: <FolderOpenOutlined />, title: 'Right file, right folder', text: 'Rules route every attachment to its folder: local drives or network shares.' },
  { icon: <SafetyCertificateOutlined />, title: 'Read-only and traceable', text: 'Emails are never changed. Every download is logged end to end.' },
];

export function LoginPage() {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onFinish = async (v: { username: string; password: string }) => {
    setBusy(true);
    setError(null);
    try {
      await login(v.username, v.password);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mv-login">
      <div className="mv-login-brand">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="mv-brand-logo" style={{ width: 40, height: 40, fontSize: 19, background: 'rgba(255,255,255,0.16)' }}>
            <InboxOutlined />
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: -0.3 }}>MailVault</div>
        </div>

        <div style={{ maxWidth: 460 }}>
          <div style={{ fontSize: 34, fontWeight: 700, lineHeight: 1.2, letterSpacing: -0.8, marginBottom: 14 }}>
            Every email attachment, filed automatically.
          </div>
          <div style={{ fontSize: 15.5, opacity: 0.82, marginBottom: 36 }}>
            The central place to manage mailboxes, download rules and a full history of every file.
          </div>
          {FEATURES.map((f) => (
            <div className="mv-login-feature" key={f.title}>
              <div className="mv-login-feature-icon">{f.icon}</div>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>{f.title}</div>
                <div style={{ opacity: 0.75, fontSize: 13.5 }}>{f.text}</div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 12.5, opacity: 0.6 }}>© {new Date().getFullYear()} MailVault · Internal use only</div>
      </div>

      <div className="mv-login-form">
        <div className="mv-login-form-inner">
          <Typography.Title level={3} style={{ marginBottom: 6, letterSpacing: -0.4 }}>
            Sign in
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 28 }}>
            Welcome back. Sign in to manage MailVault.
          </Typography.Paragraph>

          <Tooltip title="Microsoft single sign-on is enabled after the Entra ID app is registered (Phase 1).">
            <Button block size="large" icon={<WindowsFilled />} disabled>
              Sign in with Microsoft
            </Button>
          </Tooltip>

          <Divider plain style={{ color: '#94A3B8', fontSize: 12.5 }}>
            or use a local account
          </Divider>

          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

          <Form layout="vertical" requiredMark={false} onFinish={onFinish} size="large">
            <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Enter your username' }]}>
              <Input prefix={<UserOutlined className="mv-muted" />} placeholder="admin" autoComplete="username" autoFocus />
            </Form.Item>
            <Form.Item name="password" label="Password" rules={[{ required: true, message: 'Enter your password' }]}>
              <Input.Password prefix={<LockOutlined className="mv-muted" />} placeholder="••••••••••" autoComplete="current-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={busy} style={{ marginTop: 4 }}>
              Sign in
            </Button>
          </Form>
        </div>
      </div>
    </div>
  );
}
