import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchWebhooks, encryptSecret, newWebhookSecret, prisma } from '@mailvault/db';
import { syncMailbox } from '../src/pipeline/sync.js';
import { processDownloads } from '../src/pipeline/download.js';
import type { PipelineContext, PipelineSettings } from '../src/pipeline/context.js';
import { FakeProvider } from './fake-provider.js';

process.env.SECRET_ENC_KEY ||= randomBytes(32).toString('base64');

type Hit = { headers: Record<string, string>; body: string };
let hits: Hit[] = [];
let replyStatus = 200;
let server: Server;
let url = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ headers: req.headers as Record<string, string>, body });
      res.writeHead(replyStatus).end(replyStatus === 200 ? 'ok' : 'receiver error');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mailvault`;
});
afterAll(async () => {
  server.close();
  await prisma.$disconnect();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const settings: PipelineSettings = { syncIntervalMinutes: 5, retryMaxAttempts: 3, retryIntervalsMinutes: [1], maxSizeMb: 10, blockedExtensions: ['exe'], includeInline: false, timeZone: 'Asia/Kolkata' };
let fake: FakeProvider;
const dirs: string[] = [];
const ctx: PipelineContext = { providerFor: () => fake, settings: async () => settings, now: () => new Date() };

async function setup(hook: { events?: string[]; ruleIds?: (ids: { ruleId: string }) => string[] } = {}) {
  const out = await mkdtemp(join(tmpdir(), 'mv-hook-'));
  dirs.push(out);
  const dest = await prisma.destination.create({ data: { name: 'Out', basePath: out, status: 'HEALTHY' } });
  const mb = await prisma.mailbox.create({ data: { email: 'hook@test.local', monitoringStartAt: new Date('2026-01-01T00:00:00Z'), folders: { create: { providerFolderId: 'inbox', displayName: 'Inbox' } } } });
  const rule = await prisma.rule.create({
    data: {
      name: 'Invoices',
      mailboxId: mb.id,
      destinationId: dest.id,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      conditions: { senderInclude: [], senderExclude: [], recipients: [], cc: [], subjectKeywords: [], keywordMode: 'ANY', ignoreReplyPrefixes: true },
      attachments: { mode: 'SELECTED', extensions: ['pdf'], excludeNames: [], allowMultiple: true, includeInline: false },
      download: { destinationId: dest.id, subfolderPattern: '', fileNamePattern: '{OriginalName}', duplicatePolicy: 'SMART', autoDownload: true, setFileDateToReceived: false },
    },
  });
  const secret = newWebhookSecret();
  const wh = await prisma.webhook.create({
    data: { name: 'ERP', url, secretEnc: encryptSecret(secret), events: hook.events ?? ['file.saved', 'file.failed'], ruleIds: hook.ruleIds?.({ ruleId: rule.id }) ?? [] },
  });
  fake.add({ from: { email: 'billing@vendor.com' }, subject: 'Invoice 7', receivedAt: new Date('2026-11-10T09:00:00Z'), attachments: [{ id: 'p', name: 'INV-7.pdf', size: 3, isInline: false, kind: 'file', content: 'pdf' }] });
  await syncMailbox(mb.id, 'AUTO', ctx);
  await processDownloads(ctx);
  return { secret, wh, rule };
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "WebhookDelivery","Webhook","ExtractedFile","AttachmentDownload","Attachment","MessageRuleMatch","Message","SyncRun","RuleVersion","Rule","MailboxFolder","Mailbox","Destination","NotificationRecipient","Notification","ProcessingLog","User" CASCADE',
  );
  hits = [];
  replyStatus = 200;
  fake = new FakeProvider();
});

describe('outbound webhooks', () => {
  it('posts a signed file.saved event that the receiver can verify', async () => {
    const { secret } = await setup();
    expect(await dispatchWebhooks()).toBe(1);
    expect(hits).toHaveLength(1);
    const h = hits[0]!;
    expect(h.headers['x-mailvault-event']).toBe('file.saved');
    // Receiver-side verification, exactly as documented in docs/WEBHOOKS.md
    const expected = createHmac('sha256', secret).update(`${h.headers['x-mailvault-timestamp']}.${h.body}`).digest('hex');
    const got = h.headers['x-mailvault-signature']!.replace('sha256=', '');
    expect(timingSafeEqual(Buffer.from(expected), Buffer.from(got))).toBe(true);
    const payload = JSON.parse(h.body);
    expect(payload).toMatchObject({
      event: 'file.saved',
      data: { file: { name: 'INV-7.pdf', sizeBytes: 3 }, email: { from: 'billing@vendor.com', subject: 'Invoice 7', mailbox: 'hook@test.local' }, rule: { name: 'Invoices' } },
    });
    expect(payload.data.file.path).toMatch(/INV-7\.pdf$/);
    expect(payload.data.file.sha256).toHaveLength(64);
    expect(await dispatchWebhooks()).toBe(0); // delivered once only
  });

  it('respects event and rule filters', async () => {
    await setup({ events: ['job.completed'] });
    expect(await prisma.webhookDelivery.count()).toBe(0);
    await prisma.$executeRawUnsafe('TRUNCATE "WebhookDelivery","Webhook","ExtractedFile","AttachmentDownload","Attachment","MessageRuleMatch","Message","Rule","MailboxFolder","Mailbox","Destination" CASCADE');
    fake = new FakeProvider();
    await setup({ ruleIds: () => ['some-other-rule'] });
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it('retries when the receiver is down, then succeeds; gives up with one alert after the last attempt', async () => {
    const { wh } = await setup();
    await prisma.user.create({ data: { username: 'admin', displayName: 'A', role: 'SUPER_ADMIN' } });
    replyStatus = 500;
    await dispatchWebhooks();
    let d = await prisma.webhookDelivery.findFirstOrThrow();
    expect(d).toMatchObject({ status: 'RETRYING', attempts: 1, responseCode: 500 });
    expect(d.error).toBe('HTTP 500: receiver error');
    expect(await dispatchWebhooks()).toBe(0); // not due yet

    replyStatus = 200;
    await prisma.webhookDelivery.update({ where: { id: d.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await dispatchWebhooks();
    d = await prisma.webhookDelivery.findFirstOrThrow();
    expect(d).toMatchObject({ status: 'SUCCESS', attempts: 2, responseCode: 200 });
    expect((await prisma.webhook.findUniqueOrThrow({ where: { id: wh.id } })).lastStatus).toBe(200);

    // Last attempt fails → FAILED + one alert
    replyStatus = 503;
    await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'RETRYING', attempts: 5, nextAttemptAt: new Date(Date.now() - 1000) } });
    await dispatchWebhooks();
    expect((await prisma.webhookDelivery.findFirstOrThrow()).status).toBe('FAILED');
    expect(await prisma.notification.count({ where: { type: 'WEBHOOK_FAILED' } })).toBe(1);
  });
});
