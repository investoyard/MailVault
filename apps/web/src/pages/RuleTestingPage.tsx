import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Col, DatePicker, Form, Input, InputNumber, Row, Select, Skeleton, Statistic } from 'antd';
import { ExperimentOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { api } from '../api';
import { useAuth } from '../auth';
import { PageHeader } from '../components/ui';
import { TestResults, type TestEmail } from '../components/TestResults';

interface Filters {
  mailboxId: string;
  range: [Dayjs, Dayjs];
  sender?: string;
  subject?: string;
  limit: number;
}

export function RuleTestingPage() {
  const { can } = useAuth();
  const [form] = Form.useForm<Filters>();
  const [lastMailbox, setLastMailbox] = useState('');
  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<{ id: string; email: string }[]>('/api/mailboxes') });

  const search = useMutation({
    mutationFn: (f: Filters) => {
      setLastMailbox(f.mailboxId);
      return api.post<{ scanned: number; emails: TestEmail[] }>('/api/rule-testing/search', {
        mailboxId: f.mailboxId,
        from: f.range[0].startOf('day').toISOString(),
        to: f.range[1].endOf('day').toISOString(),
        sender: f.sender?.trim() || undefined,
        subject: f.subject?.trim() || undefined,
        limit: f.limit,
      });
    },
  });

  const data = search.data;
  const matchedCount = data?.emails.filter((e) => e.rules.some((r) => r.matched && r.enabled)).length ?? 0;

  return (
    <>
      <PageHeader
        title="Rule Testing"
        subtitle="Search real emails, see which rules match and why, and download selected attachments by hand. Nothing changes in the mailbox."
      />

      <Card className="mv-card" style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="vertical"
          initialValues={{ range: [dayjs().subtract(7, 'day'), dayjs()], limit: 25 }}
          onFinish={(v) => search.mutate(v)}
        >
          <Row gutter={16} align="bottom">
            <Col xs={24} md={8} xl={6}>
              <Form.Item name="mailboxId" label="Email account" rules={[{ required: true, message: 'Choose a mailbox' }]}>
                <Select placeholder="Select mailbox" options={(mailboxes.data ?? []).map((m) => ({ value: m.id, label: m.email }))} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8} xl={6}>
              <Form.Item name="range" label="Received between" rules={[{ required: true }]}>
                <DatePicker.RangePicker style={{ width: '100%' }} disabledDate={(d) => d.isAfter(dayjs())} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8} xl={4}>
              <Form.Item name="sender" label="Sender contains">
                <Input placeholder="vendor.com" allowClear />
              </Form.Item>
            </Col>
            <Col xs={24} md={8} xl={4}>
              <Form.Item name="subject" label="Subject keywords">
                <Input placeholder="invoice october" allowClear />
              </Form.Item>
            </Col>
            <Col xs={12} md={4} xl={2}>
              <Form.Item name="limit" label="Max emails">
                <InputNumber min={1} max={50} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4} xl={2}>
              <Form.Item>
                <Button type="primary" htmlType="submit" icon={<SearchOutlined />} loading={search.isPending} block>
                  Search
                </Button>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      {search.isError && <Alert type="error" showIcon message="Search failed" description={(search.error as Error).message} style={{ marginBottom: 16 }} />}

      {search.isPending && (
        <Card className="mv-card">
          <Skeleton active paragraph={{ rows: 6 }} />
        </Card>
      )}

      {data && !search.isPending && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={8}>
              <Card className="mv-card" size="small"><Statistic title="Emails checked" value={data.scanned} /></Card>
            </Col>
            <Col xs={8}>
              <Card className="mv-card" size="small"><Statistic title="Shown" value={data.emails.length} /></Card>
            </Col>
            <Col xs={8}>
              <Card className="mv-card" size="small"><Statistic title="Matched an enabled rule" value={matchedCount} valueStyle={{ color: '#16A34A' }} /></Card>
            </Col>
          </Row>
          <TestResults emails={data.emails} mailboxId={lastMailbox} canDownload={can('ruleTesting', 'execute')} />
        </>
      )}

      {!data && !search.isPending && !search.isError && (
        <Card className="mv-card">
          <div style={{ textAlign: 'center', padding: '32px 0' }} className="mv-muted">
            <ExperimentOutlined style={{ fontSize: 28, color: '#3C2E7E' }} />
            <div style={{ marginTop: 10 }}>Choose a mailbox and dates, then press Search to see how your rules treat real emails.</div>
          </div>
        </Card>
      )}
    </>
  );
}
