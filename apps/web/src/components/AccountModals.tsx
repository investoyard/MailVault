import { useEffect, useState } from 'react';
import { App, Alert, Form, Input, Modal, Radio, Select, Switch, Skeleton } from 'antd';
import { api } from '../api';

/** Change own password. When `forced`, it cannot be dismissed (first sign-in or after an admin reset). */
export function ChangePasswordModal({ open, forced, onDone }: { open: boolean; forced?: boolean; onDone: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);

  const submit = async (v: { current: string; next: string }) => {
    setBusy(true);
    try {
      await api.post('/api/auth/change-password', { current: v.current, next: v.next });
      message.success('Password changed');
      form.resetFields();
      onDone();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={forced ? 'Choose a new password' : 'Change password'}
      okText="Change password"
      onOk={() => form.submit()}
      confirmLoading={busy}
      onCancel={forced ? undefined : onDone}
      closable={!forced}
      maskClosable={false}
      keyboard={!forced}
      cancelButtonProps={{ style: forced ? { display: 'none' } : undefined }}
      destroyOnHidden
    >
      {forced && <Alert type="info" showIcon style={{ marginBottom: 16 }} message="For security, please replace the temporary password you were given." />}
      <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
        <Form.Item name="current" label="Current password" rules={[{ required: true }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="next"
          label="New password"
          rules={[{ required: true, min: 10, message: 'At least 10 characters' }, { pattern: /(?=.*[a-zA-Z])(?=.*\d)/, message: 'Use letters and numbers' }]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirm"
          label="Repeat new password"
          dependencies={['next']}
          rules={[{ required: true }, ({ getFieldValue }) => ({ validator: async (_, v) => { if (v && v !== getFieldValue('next')) throw new Error('Passwords do not match'); } })]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

interface Prefs {
  email: boolean;
  digest: 'instant' | 'daily' | 'off';
  minSeverity: 'INFO' | 'WARNING' | 'ERROR';
}

/** Per-user notification preferences (email delivery and digest). In-app alerts are always on. */
export function PreferencesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<Prefs>();
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api
      .get<{ email: string | null; prefs: Prefs }>('/api/me/preferences')
      .then((r) => {
        setEmail(r.email);
        form.setFieldsValue(r.prefs);
      })
      .finally(() => setLoading(false));
  }, [open, form]);

  const submit = async (v: Prefs) => {
    setBusy(true);
    try {
      await api.put('/api/me/preferences', v);
      message.success('Preferences saved');
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="My notification preferences" okText="Save" onOk={() => form.submit()} confirmLoading={busy} onCancel={onClose} destroyOnHidden>
      {loading ? (
        <Skeleton active />
      ) : (
        <Form form={form} layout="vertical" onFinish={submit}>
          {!email && <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="No email address on your profile. Ask an administrator to add one to receive email alerts." />}
          <Form.Item name="email" label={`Email alerts${email ? ` to ${email}` : ''}`} valuePropName="checked">
            <Switch disabled={!email} />
          </Form.Item>
          <Form.Item name="minSeverity" label="Send me alerts for">
            <Select
              options={[
                { value: 'ERROR', label: 'Errors only (failures, disconnections, service stopped)' },
                { value: 'WARNING', label: 'Errors and warnings (also low disk space, waiting downloads)' },
                { value: 'INFO', label: 'Everything (also job completions and recoveries)' },
              ]}
            />
          </Form.Item>
          <Form.Item name="digest" label="Delivery">
            <Radio.Group
              options={[
                { value: 'instant', label: 'As they happen' },
                { value: 'daily', label: 'Once a day (summary at 8:00)' },
                { value: 'off', label: 'Off (in-app only)' },
              ]}
            />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}
