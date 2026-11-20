import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '@mailvault/db';
import { GraphError } from '@mailvault/m365';
import { syncMailbox } from '../src/pipeline/sync.js';
import { processDownloads } from '../src/pipeline/download.js';
import type { PipelineContext, PipelineSettings } from '../src/pipeline/context.js';
import { FakeProvider } from './fake-provider.js';

const settings: PipelineSettings = {
  syncIntervalMinutes: 5,
  retryMaxAttempts: 3,
  retryIntervalsMinutes: [1, 5],
  maxSizeMb: 10,
  blockedExtensions: ['exe'],
  includeInline: false,
  timeZone: 'Asia/Kolkata',
};

let fake: FakeProvider;
let clock: Date;
let out: string;
const ctx: PipelineContext = { providerFor: () => fake, settings: async () => settings, now: () => clock };
const dirs: string[] = [];

async function reset() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AttachmentDownload","Attachment","MessageRuleMatch","Message","SyncRun","RuleVersion","Rule","MailboxFolder","Mailbox","Destination","Notification","ProcessingLog" CASCADE',
  );
}

async function setup(ruleOverrides: Record<string, unknown> = {}, extraRules: Record<string, unknown>[] = []) {
  const dest = await prisma.destination.create({ data: { name: 'Invoices', basePath: out, status: 'HEALTHY' } });
  const mb = await prisma.mailbox.create({
    data: {
      email: 'accounts@test.local',
      monitoringStartAt: new Date('2026-11-01T00:00:00Z'),
      folders: { create: { providerFolderId: 'inbox', displayName: 'Inbox' } },
    },
  });
  const base = (o: Record<string, unknown>) => ({
    mailboxId: mb.id,
    destinationId: dest.id,
    effectiveFrom: new Date('2026-10-01T00:00:00Z'),
    conditions: { senderInclude: ['*@vendor.com'], senderExclude: [], recipients: [], cc: [], subjectKeywords: ['invoice'], keywordMode: 'ANY', ignoreReplyPrefixes: true },
    attachments: { mode: 'SELECTED', extensions: ['pdf'], excludeNames: [], allowMultiple: true, includeInline: false },
    download: { destinationId: dest.id, subfolderPattern: '{SenderDomain}\\{yyyy}\\{MM}', fileNamePattern: '{OriginalName}', duplicatePolicy: 'SMART', autoDownload: true, setFileDateToReceived: true },
    ...o,
  });
  const rule = await prisma.rule.create({ data: { name: 'Vendor invoices', priority: 10, ...base(ruleOverrides) } as never });
  for (const r of extraRules) await prisma.rule.create({ data: base(r) as never });
  return { mb, dest, rule };
}

beforeEach(async () => {
  await reset();
  fake = new FakeProvider();
  clock = new Date('2026-11-12T10:00:00Z');
  out = await mkdtemp(join(tmpdir(), 'mv-int-'));
  dirs.push(out);
});

afterAll(async () => {
  await reset();
  await prisma.$disconnect();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const invoiceMail = (n: number, extra: object = {}) => ({
  from: { email: 'billing@vendor.com', name: 'Vendor' },
  subject: `Invoice INV-${n}`,
  receivedAt: new Date('2026-11-12T08:30:00Z'),
  attachments: [
    { id: `a${n}`, name: `INV-${n}.pdf`, size: 2000, isInline: false, kind: 'file' as const, content: `pdf ${n}` },
    { id: `l${n}`, name: 'logo.png', size: 500, isInline: true, kind: 'file' as const },
  ],
  ...extra,
});

describe('pipeline: sync → match → download', () => {
  it('downloads matching attachments into the patterned folder, skips the rest with reasons', async () => {
    const { mb } = await setup();
    fake.add(invoiceMail(1));
    fake.add({ from: { email: 'news@other.com' }, subject: 'Newsletter', receivedAt: new Date('2026-11-12T09:00:00Z'), attachments: [{ id: 'x', name: 'n.pdf', size: 10, isInline: false, kind: 'file' }] });

    const r = await syncMailbox(mb.id, 'AUTO', ctx);
    expect(r).toMatchObject({ newMessages: 2, matched: 1 });
    expect(await processDownloads(ctx)).toBe(1);

    const folder = join(out, 'vendor.com', '2026', '11');
    expect(await readdir(folder)).toEqual(['.mailvault-tmp', 'INV-1.pdf']);
    expect(await readFile(join(folder, 'INV-1.pdf'), 'utf8')).toBe('pdf 1');

    const rows = await prisma.attachmentDownload.findMany({ include: { attachment: true }, orderBy: { attachment: { name: 'asc' } } });
    expect(rows.map((d) => [d.attachment.name, d.status, d.skipReason])).toEqual([
      ['INV-1.pdf', 'SUCCESS', null],
      ['logo.png', 'SKIPPED', 'Inline image excluded'],
    ]);
    expect(rows[0]!.destinationPath).toBe(join(folder, 'INV-1.pdf'));
    expect(rows[0]!.sha256).toHaveLength(64);

    const mbAfter = await prisma.mailbox.findUniqueOrThrow({ where: { id: mb.id } });
    expect(mbAfter.status).toBe('CONNECTED');
    expect(await prisma.message.count({ where: { evaluatedAt: null } })).toBe(0);
  });

  it('processes each email once per rule, even across syncs and an expired sync position', async () => {
    const { mb } = await setup();
    fake.add(invoiceMail(1));
    await syncMailbox(mb.id, 'AUTO', ctx);
    await processDownloads(ctx);

    fake.add(invoiceMail(2));
    fake.expireCursorOnce = true; // forces a full re-sync that returns message 1 again
    const r = await syncMailbox(mb.id, 'AUTO', ctx);
    expect(r.newMessages).toBe(1);
    await processDownloads(ctx);

    expect(await prisma.messageRuleMatch.count()).toBe(2);
    expect((await readdir(join(out, 'vendor.com', '2026', '11'))).filter((f) => f.endsWith('.pdf')).sort()).toEqual(['INV-1.pdf', 'INV-2.pdf']);
  });

  it('ignores mail older than the monitoring start and rules created after the email', async () => {
    const { mb } = await setup({ effectiveFrom: new Date('2026-11-12T09:00:00Z') });
    fake.add(invoiceMail(1, { receivedAt: new Date('2026-10-15T00:00:00Z') })); // before monitoringStartAt
    fake.add(invoiceMail(2)); // received 08:30, rule effective from 09:00
    fake.add(invoiceMail(3, { receivedAt: new Date('2026-11-12T09:30:00Z') }));
    const r = await syncMailbox(mb.id, 'AUTO', ctx);
    expect(r).toMatchObject({ newMessages: 2, matched: 1 });
  });

  it('multiple rules, priority and stop-further-rules', async () => {
    const { mb, rule } = await setup({}, [
      { name: 'All PDFs', priority: 20, conditions: { senderInclude: [], senderExclude: [], recipients: [], cc: [], subjectKeywords: [], keywordMode: 'ANY', ignoreReplyPrefixes: true } },
    ]);
    fake.add(invoiceMail(1));
    await syncMailbox(mb.id, 'AUTO', ctx);
    expect(await prisma.messageRuleMatch.count()).toBe(2);

    await reset();
    const s = await setup({ stopFurtherRules: true }, [
      { name: 'All PDFs', priority: 20, conditions: { senderInclude: [], senderExclude: [], recipients: [], cc: [], subjectKeywords: [], keywordMode: 'ANY', ignoreReplyPrefixes: true } },
    ]);
    fake = new FakeProvider();
    fake.add(invoiceMail(1));
    await syncMailbox(s.mb.id, 'AUTO', ctx);
    const matches = await prisma.messageRuleMatch.findMany({ include: { rule: true } });
    expect(matches.map((m) => m.rule.name)).toEqual(['Vendor invoices']);
    expect(rule.id).toBeTruthy();
  });

  it('body conditions fetch the body only when needed; simulation and manual modes do not download', async () => {
    const { mb } = await setup({
      conditions: { senderInclude: ['*@vendor.com'], senderExclude: [], recipients: [], cc: [], subjectKeywords: [], keywordMode: 'ANY', ignoreReplyPrefixes: true, bodyContains: 'GSTIN' },
      simulationMode: true,
    });
    fake.add(invoiceMail(1, { body: 'GSTIN 27AAA' }));
    fake.add({ ...invoiceMail(2), from: { email: 'x@other.com' } });
    await syncMailbox(mb.id, 'AUTO', ctx);
    expect(fake.calls.getBodyText).toBe(1);
    const d = await prisma.attachmentDownload.findFirstOrThrow({ where: { attachment: { name: 'INV-1.pdf' } } });
    expect(d.status).toBe('SKIPPED');
    expect(d.skipReason).toMatch(/^Simulation: would save to .*vendor\.com\\2026\\11\\INV-1\.pdf$/);
    expect(await processDownloads(ctx)).toBe(0);
  });

  it('retries temporary errors with backoff, then fails with a clear message and one alert', async () => {
    const { mb } = await setup();
    await prisma.user.create({ data: { username: 'admin-test', displayName: 'A', role: 'SUPER_ADMIN' } }).catch(() => undefined);
    fake.add(invoiceMail(1));
    fake.add(invoiceMail(2));
    await syncMailbox(mb.id, 'AUTO', ctx);
    const throttled = () => new GraphError('Too many requests', 429);
    fake.failNextOpen = [throttled(), throttled()];

    await processDownloads(ctx, { concurrency: 1 });
    let rows = await prisma.attachmentDownload.findMany({ where: { status: { not: 'SKIPPED' } }, orderBy: { attachment: { name: 'asc' } } });
    expect(rows.map((r) => [r.status, r.attempts])).toEqual([
      ['RETRYING', 1],
      ['RETRYING', 1],
    ]);
    expect(rows[0]!.nextAttemptAt!.getTime() - clock.getTime()).toBe(60_000);
    expect(rows[0]!.errorMessage).toMatch(/throttling/i);

    // Not due yet: nothing happens.
    expect(await processDownloads(ctx)).toBe(0);

    // Make them due; the email for INV-2 disappears from the mailbox (permanent error).
    fake.messages = fake.messages.filter((m) => !m.subject.includes('INV-2'));
    await prisma.attachmentDownload.updateMany({ data: { nextAttemptAt: new Date(clock.getTime() - 1000) } });
    await processDownloads(ctx);
    rows = await prisma.attachmentDownload.findMany({ where: { status: { not: 'SKIPPED' } }, orderBy: { attachment: { name: 'asc' } } });
    expect(rows.map((r) => [r.status, r.attempts])).toEqual([
      ['SUCCESS', 2],
      ['FAILED', 2],
    ]);
    expect(rows[1]!.errorMessage).toBe('The email or attachment no longer exists in the mailbox');
    expect(await prisma.notification.count({ where: { type: 'DOWNLOAD_FAILED' } })).toBe(1);
  });

  it('waits (without using retries) when the destination folder is unreachable', async () => {
    const { mb, dest } = await setup();
    await prisma.destination.update({ where: { id: dest.id }, data: { basePath: 'Q:\\NoSuchDrive\\Out', status: 'HEALTHY' } });
    fake.add(invoiceMail(1));
    await syncMailbox(mb.id, 'AUTO', ctx);
    await processDownloads(ctx);
    const d = await prisma.attachmentDownload.findFirstOrThrow({ where: { status: { not: 'SKIPPED' } } });
    expect(d.status).toBe('WAITING_DESTINATION');
    expect(d.attempts).toBe(0);
    expect((await prisma.destination.findUniqueOrThrow({ where: { id: dest.id } })).status).toBe('UNAVAILABLE');
  });

  it('Graph auth failure marks the mailbox disconnected and raises one alert', async () => {
    const { mb } = await setup();
    await prisma.user.create({ data: { username: 'admin-test2', displayName: 'A', role: 'SUPER_ADMIN' } }).catch(() => undefined);
    fake.getChanges = async () => {
      throw new GraphError('Access denied', 403, 'ErrorAccessDenied');
    };
    await syncMailbox(mb.id, 'AUTO', ctx);
    await syncMailbox(mb.id, 'AUTO', ctx);
    const after = await prisma.mailbox.findUniqueOrThrow({ where: { id: mb.id } });
    expect(after.status).toBe('DISCONNECTED');
    expect(after.lastError).toMatch(/Access denied: the app has no Mail.Read permission/);
    expect(await prisma.notification.count({ where: { type: 'MAILBOX_DISCONNECTED' } })).toBe(1);
  });
});
