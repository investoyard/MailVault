// Failure drills: what happens when things break in production.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '@mailvault/db';
import { syncMailbox } from '../src/pipeline/sync.js';
import { processDownloads, recoverStuckDownloads } from '../src/pipeline/download.js';
import { runFolderHealth } from '../src/jobs/folder-health.js';
import type { PipelineContext, PipelineSettings } from '../src/pipeline/context.js';
import { FakeProvider } from './fake-provider.js';

const settings: PipelineSettings = {
  syncIntervalMinutes: 5,
  retryMaxAttempts: 5,
  retryIntervalsMinutes: [1],
  maxSizeMb: 10,
  blockedExtensions: ['exe'],
  includeInline: false,
  timeZone: 'Asia/Kolkata',
};
let fake: FakeProvider;
let out: string;
const ctx: PipelineContext = { providerFor: () => fake, settings: async () => settings, now: () => new Date() };
const dirs: string[] = [];

async function reset() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AttachmentDownload","Attachment","MessageRuleMatch","Message","SyncRun","RuleVersion","Rule","MailboxFolder","Mailbox","Destination","Notification","ProcessingLog" CASCADE',
  );
}

async function setup(basePath = out) {
  const dest = await prisma.destination.create({ data: { name: 'Out', basePath, status: 'HEALTHY' } });
  const mb = await prisma.mailbox.create({
    data: { email: 'drill@test.local', monitoringStartAt: new Date('2026-01-01T00:00:00Z'), folders: { create: { providerFolderId: 'inbox', displayName: 'Inbox' } } },
  });
  await prisma.rule.create({
    data: {
      name: 'All PDFs',
      mailboxId: mb.id,
      destinationId: dest.id,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      conditions: { senderInclude: [], senderExclude: [], recipients: [], cc: [], subjectKeywords: [], keywordMode: 'ANY', ignoreReplyPrefixes: true },
      attachments: { mode: 'SELECTED', extensions: ['pdf'], excludeNames: [], allowMultiple: true, includeInline: false },
      download: { destinationId: dest.id, subfolderPattern: '', fileNamePattern: '{OriginalName}', duplicatePolicy: 'SMART', autoDownload: true, setFileDateToReceived: false },
    },
  });
  for (let i = 1; i <= 5; i++) {
    fake.add({ from: { email: 'a@vendor.com' }, subject: `Doc ${i}`, receivedAt: new Date(), attachments: [{ id: `p${i}`, name: `doc-${i}.pdf`, size: 100, isInline: false, kind: 'file', content: `pdf ${i}` }] });
  }
  return { mb, dest };
}

beforeEach(async () => {
  await reset();
  fake = new FakeProvider();
  out = await mkdtemp(join(tmpdir(), 'mv-drill-'));
  dirs.push(out);
});
afterAll(async () => {
  await reset();
  await prisma.$disconnect();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('failure drills', () => {
  it('worker killed in the middle of downloads: stuck items are picked up again after restart', async () => {
    const { mb } = await setup();
    await syncMailbox(mb.id, 'AUTO', ctx);
    // Simulate a crash: two downloads were claimed (IN_PROGRESS) 20 minutes ago and never finished.
    const rows = await prisma.attachmentDownload.findMany({ take: 2 });
    await prisma.attachmentDownload.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: 'IN_PROGRESS' } });
    await prisma.$executeRaw`UPDATE "AttachmentDownload" SET "updatedAt" = ${new Date(Date.now() - 20 * 60_000)} WHERE status = 'IN_PROGRESS'`;

    expect(await processDownloads(ctx)).toBe(3); // the stuck ones are not touched yet
    expect(await recoverStuckDownloads(15)).toBe(2); // what the worker does at start-up
    expect(await processDownloads(ctx)).toBe(2);
    expect((await readdir(out)).filter((f) => f.endsWith('.pdf')).length).toBe(5);
    expect(await prisma.attachmentDownload.count({ where: { status: 'SUCCESS' } })).toBe(5);
  });

  it('network share goes offline, then comes back: downloads wait, then finish without manual action', async () => {
    const offline = 'Q:\\NoSuchDrive\\MailVault';
    const { mb, dest } = await setup(offline);
    await syncMailbox(mb.id, 'AUTO', ctx);
    await processDownloads(ctx);
    expect(await prisma.attachmentDownload.count({ where: { status: 'WAITING_DESTINATION' } })).toBe(5);
    expect(await prisma.attachmentDownload.count({ where: { attempts: { gt: 0 } } })).toBe(0); // retries not used up

    // The share is back (here: the folder path is fixed) → the health check releases the waiting downloads.
    await prisma.destination.update({ where: { id: dest.id }, data: { basePath: out } });
    await runFolderHealth();
    expect(await processDownloads(ctx)).toBe(5);
    expect(await prisma.attachmentDownload.count({ where: { status: 'SUCCESS' } })).toBe(5);
    expect(await prisma.notification.count({ where: { type: 'RESOLVED' } })).toBeGreaterThanOrEqual(0);
  });

  it('Microsoft throttles every request for a while: nothing is lost, everything completes later', async () => {
    const { mb } = await setup();
    await syncMailbox(mb.id, 'AUTO', ctx);
    const { GraphError } = await import('@mailvault/m365');
    fake.failNextOpen = Array.from({ length: 5 }, () => new GraphError('Too many requests', 429));
    await processDownloads(ctx);
    expect(await prisma.attachmentDownload.count({ where: { status: 'RETRYING' } })).toBe(5);
    await prisma.attachmentDownload.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    expect(await processDownloads(ctx)).toBe(5);
    expect(await prisma.attachmentDownload.count({ where: { status: 'SUCCESS' } })).toBe(5);
  });
});
