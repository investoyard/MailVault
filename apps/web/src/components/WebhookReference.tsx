import type { ReactNode } from 'react';
import { Alert, Card, Col, Row, Table, Tabs, Tag, Typography } from 'antd';
import { ApiOutlined } from '@ant-design/icons';

// Reference for the team that builds the receiving system. Samples mirror what the worker sends
// (packages/db/src/webhooks.ts + apps/worker/src/pipeline/download.ts / historical.ts).

const email = {
  mailbox: 'aif@finwave.co',
  from: 'reports@broker.example',
  subject: 'Client Daily Statement - 0000 - 20261117',
  receivedAt: '2026-11-17T12:31:04.000Z',
  internetMessageId: '<a1b2c3@broker.example>',
};
const rule = { id: 'cmwn7gyuq0007dwuibf1izsm1', name: 'Orient Daily - 0000' };

const SAMPLES: Record<string, object> = {
  'file.saved': {
    id: 'cmwq0k2a9f0001x7d3h5k8m2p',
    event: 'file.saved',
    occurredAt: '2026-11-17T12:31:09.512Z',
    data: {
      downloadId: 'cmwq0k1z30000x7d3a9b8c7d6',
      file: {
        name: 'Client Daily Statement - 0000 - 20261117.zip',
        path: 'D:\\MailVault-Files\\2026-27\\November, 2026\\Client Daily Statement - 0000 - 20261117.zip',
        sizeBytes: 183422,
        sha256: '9f2c4e1b7a0d3c5e8f6a2b4d1c3e5f7a9b0c2d4e6f8a1b3c5d7e9f0a2b4c6d8e',
      },
      email,
      rule,
      attachment: { name: 'Client Daily Statement - 0000 - 20261117.zip', sizeBytes: 183422 },
    },
  },
  'file.saved (from a ZIP)': {
    id: 'cmwq0k2a9f0002x7d3h5k8m2p',
    event: 'file.saved',
    occurredAt: '2026-11-17T12:31:10.044Z',
    data: {
      downloadId: 'cmwq0k1z30000x7d3a9b8c7d6',
      file: {
        name: 'Statement-0000.pdf',
        path: 'D:\\MailVault-Files\\2026-27\\November, 2026\\Statement-0000.pdf',
        sizeBytes: 98211,
        sha256: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
        extractedFrom: { name: 'Client Daily Statement - 0000 - 20261117.zip', innerPath: 'Statements/Statement-0000.pdf' },
      },
      email,
      rule,
      attachment: { name: 'Client Daily Statement - 0000 - 20261117.zip', sizeBytes: 183422 },
    },
  },
  'file.failed': {
    id: 'cmwq0m7c1d0003x7d3q2w4e6r',
    event: 'file.failed',
    occurredAt: '2026-11-17T13:02:41.207Z',
    data: {
      downloadId: 'cmwq0k1z30000x7d3a9b8c7d6',
      file: { name: 'Client Daily Statement - 0000 - 20261117.zip' },
      email,
      rule,
      attachment: { name: 'Client Daily Statement - 0000 - 20261117.zip', sizeBytes: 183422 },
      error: { code: 'SOURCE_GONE', message: 'The email or attachment no longer exists in the mailbox' },
    },
  },
  'job.completed': {
    id: 'cmwq1a9b2c0004x7d3t5y7u9i',
    event: 'job.completed',
    occurredAt: '2026-11-19T07:06:07.315Z',
    data: {
      jobId: 'cmwn7i0q2000bdwuiil65j00x',
      mailbox: 'aif@finwave.co',
      mode: 'execute',
      dateFrom: '2026-11-16T18:30:00.000Z',
      dateTo: '2026-11-18T18:29:59.999Z',
      scanned: 51,
      matched: 2,
      filesQueued: 2,
    },
  },
  ping: {
    id: 'cmwq1c3d4e0005x7d3o1p3a5s',
    event: 'ping',
    occurredAt: '2026-11-19T08:15:00.000Z',
    data: { message: 'Test from MailVault', by: 'admin' },
  },
};

type Field = { field: string; type: string; meaning: ReactNode };

const COMMON: Field[] = [
  { field: 'id', type: 'string', meaning: 'Unique ID of this delivery. Retries send the same id: use it to ignore duplicates.' },
  { field: 'event', type: 'string', meaning: 'file.saved, file.failed, job.completed or ping' },
  { field: 'occurredAt', type: 'ISO date (UTC)', meaning: 'When the event happened' },
];

const FILE_FIELDS: Field[] = [
  ...COMMON,
  { field: 'data.downloadId', type: 'string', meaning: 'MailVault download record (same for all files unpacked from one ZIP)' },
  { field: 'data.file.name', type: 'string', meaning: 'File name as saved (after the rule\'s naming and duplicate handling)' },
  { field: 'data.file.path', type: 'string', meaning: <>Full path of the saved file on the server or share. <i>file.saved only</i></> },
  { field: 'data.file.sizeBytes', type: 'number', meaning: <>Size in bytes. <i>file.saved only</i></> },
  { field: 'data.file.sha256', type: 'string', meaning: <>SHA-256 hash (64 hex characters), to check the file is complete. <i>file.saved only</i></> },
  { field: 'data.file.extractedFrom', type: 'object', meaning: <>Only for files unpacked from a ZIP or attached email: <span className="mv-mono">name</span> of the container and <span className="mv-mono">innerPath</span> inside it</> },
  { field: 'data.email.mailbox', type: 'string', meaning: 'Monitored mailbox the email arrived in' },
  { field: 'data.email.from', type: 'string', meaning: 'Sender address' },
  { field: 'data.email.subject', type: 'string', meaning: 'Email subject' },
  { field: 'data.email.receivedAt', type: 'ISO date (UTC)', meaning: 'When the email was received' },
  { field: 'data.email.internetMessageId', type: 'string', meaning: 'Standard email Message-ID header' },
  { field: 'data.rule.id / name', type: 'string', meaning: 'Rule that saved the file' },
  { field: 'data.attachment.name / sizeBytes', type: 'string / number', meaning: 'The original attachment as it was in the email' },
  {
    field: 'data.error.code / message',
    type: 'string',
    meaning: (
      <>
        <i>file.failed only.</i> Codes: <Tag>SOURCE_GONE</Tag> email deleted, <Tag>TOO_LARGE</Tag> over the size limit, <Tag>EXTRACT_FAILED</Tag> damaged or protected ZIP,{' '}
        <Tag>DEST_UNAVAILABLE</Tag> folder unreachable, <Tag>GRAPH_…</Tag> Microsoft 365 error, <Tag>UNKNOWN</Tag>
      </>
    ),
  },
];

const JOB_FIELDS: Field[] = [
  ...COMMON,
  { field: 'data.jobId', type: 'string', meaning: 'Historical job ID' },
  { field: 'data.mailbox', type: 'string', meaning: 'Mailbox the job scanned' },
  { field: 'data.mode', type: 'string', meaning: 'simulate (nothing saved) or execute' },
  { field: 'data.dateFrom / dateTo', type: 'ISO date (UTC)', meaning: 'Date range of emails scanned' },
  { field: 'data.scanned / matched / filesQueued', type: 'number', meaning: 'Emails scanned, emails matched, files queued for saving (0 in simulate mode)' },
];

const HEADERS: Field[] = [
  { field: 'Content-Type', type: 'application/json', meaning: 'Body is UTF-8 JSON' },
  { field: 'X-MailVault-Event', type: 'file.saved', meaning: 'Same as the event field' },
  { field: 'X-MailVault-Delivery', type: 'cmwq0k2a9f…', meaning: 'Same as the id field' },
  { field: 'X-MailVault-Timestamp', type: '1795072967', meaning: 'Unix seconds when this attempt was sent' },
  { field: 'X-MailVault-Signature', type: 'sha256=5d41…', meaning: 'HMAC-SHA256 of "<timestamp>.<raw body>" with the signing secret' },
  { field: 'User-Agent', type: 'MailVault-Webhook/1.0', meaning: '' },
];

const CODE: Record<string, string> = {
  'Node.js': `import express from 'express';
import crypto from 'node:crypto';

const SECRET = process.env.MAILVAULT_WEBHOOK_SECRET; // whsec_...
const app = express();

app.post('/api/mailvault', express.raw({ type: 'application/json' }), (req, res) => {
  const ts = req.get('X-MailVault-Timestamp');
  const sig = req.get('X-MailVault-Signature') ?? '';
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(\`\${ts}.\${req.body}\`).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  if (!fresh || sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(401).send('bad signature');
  }
  const event = JSON.parse(req.body.toString('utf8'));
  // Ignore if event.id was already processed, then queue your work.
  res.status(200).send('ok');
});`,
  'C# (.NET)': `app.MapPost("/api/mailvault", async (HttpRequest req) =>
{
    using var reader = new StreamReader(req.Body);
    var body = await reader.ReadToEndAsync();
    var ts = req.Headers["X-MailVault-Timestamp"].ToString();
    var sig = req.Headers["X-MailVault-Signature"].ToString();
    var secret = Environment.GetEnvironmentVariable("MAILVAULT_WEBHOOK_SECRET")!;

    using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
    var expected = "sha256=" + Convert.ToHexString(
        hmac.ComputeHash(Encoding.UTF8.GetBytes($"{ts}.{body}"))).ToLowerInvariant();
    var fresh = Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - long.Parse(ts)) < 300;

    if (!fresh || !CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(sig), Encoding.UTF8.GetBytes(expected)))
        return Results.Unauthorized();

    // Ignore duplicates by the "id" field, then queue your work.
    return Results.Ok();
});`,
  Python: `import hashlib, hmac, json, os, time
from flask import Flask, request, abort

SECRET = os.environ["MAILVAULT_WEBHOOK_SECRET"].encode()
app = Flask(__name__)

@app.post("/api/mailvault")
def mailvault():
    body = request.get_data()                      # raw bytes, before JSON parsing
    ts = request.headers.get("X-MailVault-Timestamp", "")
    sig = request.headers.get("X-MailVault-Signature", "")
    expected = "sha256=" + hmac.new(SECRET, f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    if abs(time.time() - int(ts or 0)) > 300 or not hmac.compare_digest(sig, expected):
        abort(401)
    event = json.loads(body)
    # Ignore if event["id"] was already processed, then queue your work.
    return "ok", 200`,
};

function CodeBlock({ text }: { text: string }) {
  return (
    <div style={{ position: 'relative' }}>
      <Typography.Paragraph copyable={{ text, tooltips: ['Copy', 'Copied'] }} style={{ position: 'absolute', top: 6, right: 10, margin: 0, zIndex: 1 }}>
        {''}
      </Typography.Paragraph>
      <pre
        className="mv-mono"
        style={{ margin: 0, padding: '12px 14px', background: '#1F1B33', color: '#E8E5F7', borderRadius: 10, fontSize: 12.5, lineHeight: 1.55, overflow: 'auto', maxHeight: 460 }}
      >
        {text}
      </pre>
    </div>
  );
}

function FieldTable({ rows, firstCol = 'Field', secondCol = 'Type' }: { rows: Field[]; firstCol?: string; secondCol?: string }) {
  return (
    <Table
      size="small"
      pagination={false}
      rowKey="field"
      dataSource={rows}
      columns={[
        { title: firstCol, dataIndex: 'field', width: 230, render: (v: string) => <span className="mv-mono" style={{ fontSize: 12.5 }}>{v}</span> },
        { title: secondCol, dataIndex: 'type', width: 170, render: (v: string) => <span className="mv-muted mv-mono" style={{ fontSize: 12 }}>{v}</span> },
        { title: 'Meaning', dataIndex: 'meaning' },
      ]}
    />
  );
}

const EVENT_TABS: { key: string; label: string; when: ReactNode; fields: Field[] }[] = [
  { key: 'file.saved', label: 'file.saved', when: 'An attachment was saved to its destination folder.', fields: FILE_FIELDS },
  {
    key: 'file.saved (from a ZIP)',
    label: 'file.saved (ZIP)',
    when: 'A file was unpacked from a ZIP or attached email and saved. One event per unpacked file; extractedFrom names the container.',
    fields: FILE_FIELDS,
  },
  { key: 'file.failed', label: 'file.failed', when: 'A download failed permanently (after all retries, or straight away when retrying cannot help).', fields: FILE_FIELDS },
  { key: 'job.completed', label: 'job.completed', when: 'A historical job finished (Simulate or Execute).', fields: JOB_FIELDS },
  { key: 'ping', label: 'ping', when: 'Sent by the "Send a test message" button. Reply 2xx; no action needed.', fields: COMMON },
];

/** Payload reference for the team that builds the receiving system. */
export function WebhookReference() {
  return (
    <Card
      className="mv-card"
      title={
        <span>
          <ApiOutlined style={{ marginRight: 8 }} />
          Webhook reference: what MailVault sends
        </span>
      }
    >
      <Typography.Paragraph style={{ marginBottom: 16 }}>
        For every event, MailVault sends <span className="mv-mono">POST &lt;your URL&gt;</span> with a JSON body. Answer with any <b>2xx</b> status within <b>10 seconds</b>; otherwise it retries
        after 1, 5, 15, 60 and 240 minutes, then marks the delivery failed and alerts the administrators. Email bodies are never sent, only the details below.
      </Typography.Paragraph>

      <Typography.Title level={5} style={{ marginTop: 0 }}>
        Events and sample data
      </Typography.Title>
      <Tabs
        type="card"
        size="small"
        items={EVENT_TABS.map((t) => ({
          key: t.key,
          label: <span className="mv-mono">{t.label}</span>,
          children: (
            <>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                {t.when}
              </Typography.Paragraph>
              <Row gutter={[16, 16]}>
                <Col xs={24} xl={11}>
                  <CodeBlock text={JSON.stringify(SAMPLES[t.key], null, 2)} />
                </Col>
                <Col xs={24} xl={13}>
                  <FieldTable rows={t.fields} />
                </Col>
              </Row>
            </>
          ),
        }))}
      />

      <Typography.Title level={5} style={{ marginTop: 24 }}>
        Request headers
      </Typography.Title>
      <FieldTable rows={HEADERS} firstCol="Header" secondCol="Example" />

      <Typography.Title level={5} style={{ marginTop: 24 }}>
        Verify the signature
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        Compute <span className="mv-mono">sha256=HMAC_SHA256(secret, timestamp + "." + raw body)</span> and compare it with <span className="mv-mono">X-MailVault-Signature</span>. Use the raw
        body exactly as received (before JSON parsing) and reject timestamps older than 5 minutes.
      </Typography.Paragraph>
      <Tabs size="small" items={Object.entries(CODE).map(([k, v]) => ({ key: k, label: k, children: <CodeBlock text={v} /> }))} />

      <Alert
        style={{ marginTop: 16 }}
        type="info"
        showIcon
        message="Good practice for the receiver"
        description={
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>Treat <span className="mv-mono">id</span> as an idempotency key: a retry sends the same id, so process each id once.</li>
            <li>Reply quickly and do the real work in the background (10-second limit).</li>
            <li>
              <span className="mv-mono">file.path</span> is a path on the MailVault server or a network share; the receiving system needs read access to it.
            </li>
            <li>If the signing secret leaks, create a new one (key icon in the list above) and update the receiver at the same time.</li>
          </ul>
        }
      />
    </Card>
  );
}
