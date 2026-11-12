import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Form, Input, Tooltip } from 'antd';
import { ArrowRightOutlined, InboxOutlined, LockOutlined, SafetyCertificateOutlined, ThunderboltOutlined, UserOutlined, WarningOutlined, WindowsFilled, FileSearchOutlined } from '@ant-design/icons';
import { useAuth } from '../auth';

const REMEMBER_KEY = 'mv.lastUsername';
const readRemembered = () => {
  try {
    return localStorage.getItem(REMEMBER_KEY) ?? '';
  } catch {
    return '';
  }
};

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/** Animated illustration: emails flow into the vault, rules sort them, files land in folders. */
function VaultScene() {
  return (
    <svg className="mv-scene" viewBox="0 0 480 300" role="img" aria-label="Emails flow into MailVault and attachments are filed into folders">
      <defs>
        <radialGradient id="vaultGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#B9AEE8" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#B9AEE8" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="vaultBody" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0.06" />
        </linearGradient>
      </defs>

      {/* Flow lines */}
      <g className="mv-flow-lines" fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="1.5" strokeDasharray="4 6">
        <path d="M78 90 C 140 90, 170 150, 214 150" />
        <path d="M78 150 L 214 150" />
        <path d="M78 210 C 140 210, 170 150, 214 150" />
        <path d="M266 150 C 320 150, 340 80, 396 80" />
        <path d="M266 150 L 396 150" />
        <path d="M266 150 C 320 150, 340 220, 396 220" />
      </g>

      {/* Mailboxes */}
      {[90, 150, 210].map((y) => (
        <g key={y} transform={`translate(34 ${y - 18})`}>
          <rect width="44" height="36" rx="9" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.3)" />
          <path d="M10 12 L22 21 L34 12" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="10" y="11" width="24" height="16" rx="2.5" fill="none" stroke="#fff" strokeWidth="2" />
        </g>
      ))}

      {/* Vault */}
      <circle cx="240" cy="150" r="64" fill="url(#vaultGlow)" className="mv-vault-glow" />
      <circle cx="240" cy="150" r="44" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.5" strokeDasharray="3 7" className="mv-vault-ring" />
      <rect x="212" y="122" width="56" height="56" rx="16" fill="url(#vaultBody)" stroke="rgba(255,255,255,0.55)" strokeWidth="1.5" />
      <path d="M240 134 l12 5 v9 c0 8 -5 13 -12 16 c-7 -3 -12 -8 -12 -16 v-9 z" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M235 150 l4 4 l7 -8" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="mv-vault-check" />

      {/* Folders */}
      {[
        { y: 80, label: 'Invoices' },
        { y: 150, label: 'Statements' },
        { y: 220, label: 'Contracts' },
      ].map((f) => (
        <g key={f.y} transform={`translate(396 ${f.y - 16})`}>
          <path d="M0 6 a4 4 0 0 1 4 -4 h12 l5 5 h21 a4 4 0 0 1 4 4 v19 a4 4 0 0 1 -4 4 h-38 a4 4 0 0 1 -4 -4 z" fill="rgba(255,255,255,0.14)" stroke="rgba(255,255,255,0.45)" />
          <text x="23" y="48" textAnchor="middle" fontSize="10.5" fill="rgba(255,255,255,0.78)" fontFamily="inherit">
            {f.label}
          </text>
        </g>
      ))}

      {/* Moving envelopes (into the vault) */}
      {['M78 90 C 140 90, 170 150, 214 150', 'M78 150 L 214 150', 'M78 210 C 140 210, 170 150, 214 150'].map((d, i) => (
        <g key={d} className="mv-mover mv-mover-in" style={{ offsetPath: `path('${d}')`, animationDelay: `${i * 1.1}s` }}>
          <rect x="-9" y="-6.5" width="18" height="13" rx="2.5" fill="#fff" />
          <path d="M-8 -5 L0 1 L8 -5" fill="none" stroke="#3C2E7E" strokeWidth="1.6" />
        </g>
      ))}

      {/* Moving files (out to folders) */}
      {[
        { d: 'M266 150 C 320 150, 340 80, 396 80', label: 'PDF', color: '#EF4444' },
        { d: 'M266 150 L 396 150', label: 'XLS', color: '#16A34A' },
        { d: 'M266 150 C 320 150, 340 220, 396 220', label: 'DOC', color: '#2563EB' },
      ].map((f, i) => (
        <g key={f.d} className="mv-mover mv-mover-out" style={{ offsetPath: `path('${f.d}')`, animationDelay: `${0.9 + i * 1.1}s` }}>
          <rect x="-11" y="-8" width="22" height="16" rx="3" fill="#fff" />
          <text x="0" y="3.5" textAnchor="middle" fontSize="8" fontWeight="700" fill={f.color} fontFamily="inherit">
            {f.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

const POINTS = [
  { icon: <ThunderboltOutlined />, title: 'Hands-free', text: 'New emails checked every few minutes, day and night.' },
  { icon: <SafetyCertificateOutlined />, title: 'Read-only', text: 'Mailboxes are never changed. Only Mail.Read access.' },
  { icon: <FileSearchOutlined />, title: 'Fully traced', text: 'Every file: which email, which rule, which folder.' },
];

export function LoginPage() {
  const { login } = useAuth();
  const [form] = Form.useForm();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const remembered = useMemo(readRemembered, []);
  const hello = useMemo(greeting, []);

  useEffect(() => {
    document.title = 'Sign in · MailVault';
    return () => {
      document.title = 'MailVault';
    };
  }, []);

  const onFinish = async (v: { username: string; password: string; remember: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      await login(v.username, v.password);
      try {
        if (v.remember) localStorage.setItem(REMEMBER_KEY, v.username);
        else localStorage.removeItem(REMEMBER_KEY);
      } catch {
        /* storage unavailable */
      }
    } catch (e) {
      setError((e as Error).message);
      form.setFieldValue('password', '');
    } finally {
      setBusy(false);
    }
  };

  const watchCaps = (e: React.KeyboardEvent) => setCapsLock(e.getModifierState?.('CapsLock') ?? false);

  return (
    <div className="mv-login">
      <aside className="mv-login-brand">
        <div className="mv-login-aurora" aria-hidden />
        <header className="mv-login-logo">
          <span className="mv-login-logo-mark">
            <InboxOutlined />
          </span>
          <span>MailVault</span>
        </header>

        <div className="mv-login-hero">
          <h1>
            Every attachment,
            <br />
            <span>filed by itself.</span>
          </h1>
          <p>Microsoft 365 mailboxes in, the right files in the right folders out, with a full record of every step.</p>
          <VaultScene />
        </div>

        <ul className="mv-login-points">
          {POINTS.map((p) => (
            <li key={p.title}>
              <span className="mv-login-point-icon">{p.icon}</span>
              <span>
                <b>{p.title}</b>
                <small>{p.text}</small>
              </span>
            </li>
          ))}
        </ul>
      </aside>

      <main className="mv-login-panel">
        <div className="mv-login-card">
          <div className="mv-login-card-logo">
            <span className="mv-login-logo-mark">
              <InboxOutlined />
            </span>
            MailVault
          </div>
          <p className="mv-login-eyebrow">{hello}</p>
          <h2>Sign in to MailVault</h2>
          <p className="mv-login-sub">Use the account your administrator gave you.</p>

          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 18 }} />}

          <Form form={form} layout="vertical" requiredMark={false} onFinish={onFinish} size="large" initialValues={{ username: remembered, remember: !!remembered }}>
            <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Enter your username' }]}>
              <Input prefix={<UserOutlined className="mv-muted" />} placeholder="your.name" autoComplete="username" autoFocus={!remembered} />
            </Form.Item>
            <Form.Item
              name="password"
              label="Password"
              rules={[{ required: true, message: 'Enter your password' }]}
              extra={
                capsLock ? (
                  <span className="mv-login-caps">
                    <WarningOutlined /> Caps Lock is on
                  </span>
                ) : undefined
              }
            >
              <Input.Password prefix={<LockOutlined className="mv-muted" />} placeholder="••••••••••" autoComplete="current-password" autoFocus={!!remembered} onKeyUp={watchCaps} onKeyDown={watchCaps} />
            </Form.Item>
            <Form.Item name="remember" valuePropName="checked" style={{ marginBottom: 18 }}>
              <Checkbox>Remember my username on this computer</Checkbox>
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={busy} className="mv-login-submit">
              Sign in <ArrowRightOutlined />
            </Button>
          </Form>

          <div className="mv-login-divider">
            <span>or</span>
          </div>
          <Tooltip title="Available once Microsoft 365 sign-in is connected by your administrator.">
            <Button block size="large" icon={<WindowsFilled />} disabled>
              Sign in with Microsoft
            </Button>
          </Tooltip>

          <p className="mv-login-foot">
            <SafetyCertificateOutlined /> Protected sign-in · {new Date().getFullYear()} MailVault
          </p>
        </div>
      </main>
    </div>
  );
}
