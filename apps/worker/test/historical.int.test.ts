import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '@mailvault/db';
import { runHistoricalJob, runManualDownload } from '../src/pipeline/historical.js';
import { syncMailbox } from '../src/pipeline/sync.js';
import { processDownloads } from '../src/pipeline/download.js';
import type { PipelineContext, PipelineSettings } from '../src/pipeline/context.js';
import { FakeProvider } from './fake-provider.js';

const settings: PipelineSettings = {
  syncIntervalMinutes: 5,
  retryMaxAttempts: 3,
  retryIntervalsMinutes: [1],
  maxSizeMb: 10,
  blockedExtensions: ['exe'],
  includeInline: false,
  timeZone: 'Asia/Kolkata',
};
let fake: FakeProvider;
let out: string;
const clock = new Date('2026-11-12T10:00:00Z');
const ctx: PipelineContext = { providerFor: () => fake, settings: async () => settings, now: () => clock };
const dirs: string[] = [];

async function reset() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AttachmentDownload","Attachment","MessageRuleMatch","Message","SyncRun","HistoricalJob","RuleVersion","Rule","MailboxFolder","Mailbox","Destination","Notification","ProcessingLog" CASCADE',
  );
}

async function setup() {
  const dest = await prisma.destination.create({ data: { name: 'Out', basePath: out, status: 'HEALTHY' } });
  const mb = await prisma.mailbox.create({
    data: { email: 'hist@test.local', monitoringStartAt: new Date('2026-11-10T00:00:00Z'), folders: { create: { providerFolderId: 'inbox', displayName: 'Inbox' } } },
  });
  const rule = await prisma.rule.create({
    data: {
      name: 'Invoices',
      mailboxId: mb.id,
      destinationId: dest.id,
      effectiveFrom: new Date('2026-11-12T00:00:00Z'), // created "today": old mail only via historical jobs
      conditions: { senderInclude: ['*@vendor.com'], senderExclude: [], recipients: [], cc: [], subjectKeywords: [], keywordMode: 'ANY', ignoreReplyPrefixes: true },
      attachments: { mode: 'SELECTED', extensions: ['pdf'], excludeNames: [], allowMultiple: true, includeInline: false },
      download: { destinationId: dest.id, subfolderPattern: '', fileNamePattern: '{OriginalName}', duplicatePolicy: 'SMART', autoDownload: true, setFileDateToReceived: false },
    },
  });
  return { mb, rule };
}

const mail = (n: number, day: string, from = 'billing@vendor.com') => ({
  from: { email: from },
  subject: `Invoice ${n}`,
  receivedAt: new Date(`${day}T09:00:00Z`),
  attachments: [
    { id: `p${n}`, name: `INV-${n}.pdf`, size: 1000, isInline: false, kind: 'file' as const, content: `pdf ${n}` },
    { id: `x${n}`, name: `data-${n}.xlsx`, size: 1000, isInline: false, kind: 'file' as const },
  ],
});

beforeEach(async () => {
  await reset();
  fake = new FakeProvider();
  out = await mkdtemp(join(tmpdir(), 'mv-hist-'));
  dirs.push(out);
});
afterAll(async () => {
  await reset();
  await prisma.$disconnect();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('historical jobs', () => {
  it('simulate first, then execute, resumable across pages, never duplicating', async () => {
    const { mb, rule } = await setup();
    for (let i = 1; i <= 120; i++) fake.add(mail(i, i % 2 ? '2026-10-05' : '2026-10-20'));
    fake.add(mail(999, '2026-10-06', 'news@other.com'));
    fake.add(mail(1000, '2026-09-01')); // outside the range

    const sim = await prisma.historicalJob.create({
      data: { mailboxId: mb.id, ruleIds: [rule.id], dateFrom: new Date('2026-10-01T00:00:00Z'), dateTo: new Date('2026-10-31T23:59:59Z'), simulate: true },
    });
    await runHistoricalJob(sim.id, ctx);
    const simDone = await prisma.historicalJob.findUniqueOrThrow({ where: { id: sim.id } });
    expect(simDone).toMatchObject({ status: 'COMPLETED', scanned: 121, matched: 120, downloaded: 0 });
    expect(fake.calls2.search).toBe(3); // 50 + 50 + 21
    expect(await processDownloads(ctx)).toBe(0);
    const simRow = await prisma.attachmentDownload.findFirstOrThrow({ where: { attachment: { name: 'INV-1.pdf' } } });
    expect(simRow.skipReason).toMatch(/^Simulation: would save to/);

    // Execute: the simulation already "processed" these emails for the rule, so reprocess explicitly.
    const exec = await prisma.historicalJob.create({
      data: { mailboxId: mb.id, ruleIds: [rule.id], dateFrom: new Date('2026-10-01T00:00:00Z'), dateTo: new Date('2026-10-31T23:59:59Z'), simulate: false, includeProcessed: true },
    });
    await runHistoricalJob(exec.id, ctx);
    expect(await prisma.historicalJob.findUniqueOrThrow({ where: { id: exec.id } })).toMatchObject({ status: 'COMPLETED', matched: 120, downloaded: 120 });
    expect(await processDownloads(ctx)).toBe(120);
    expect((await readdir(out)).filter((f) => f.endsWith('.pdf')).length).toBe(120);

    // Running the same execution again without "include processed" does nothing new.
    const again = await prisma.historicalJob.create({
      data: { mailboxId: mb.id, ruleIds: [rule.id], dateFrom: new Date('2026-10-01T00:00:00Z'), dateTo: new Date('2026-10-31T23:59:59Z'), simulate: false },
    });
    await runHistoricalJob(again.id, ctx);
    expect(await prisma.historicalJob.findUniqueOrThrow({ where: { id: again.id } })).toMatchObject({ matched: 0, downloaded: 0 });

    // Old emails are marked evaluated so automatic sync never touches them.
    expect(await prisma.message.count({ where: { evaluatedAt: null } })).toBe(0);
  });

  it('stops when cancelled and resumes from the saved checkpoint', async () => {
    const { mb, rule } = await setup();
    for (let i = 1; i <= 120; i++) fake.add(mail(i, '2026-10-05'));
    const job = await prisma.historicalJob.create({
      data: { mailboxId: mb.id, ruleIds: [rule.id], dateFrom: new Date('2026-10-01T00:00:00Z'), dateTo: new Date('2026-10-31T00:00:00Z'), simulate: false },
    });
    // Cancel as soon as the first page is saved.
    const realSearch = fake.search.bind(fake);
    let pages = 0;
    fake.search = async (q) => {
      if (++pages === 2) await prisma.historicalJob.update({ where: { id: job.id }, data: { status: 'CANCELLED' } });
      return realSearch(q);
    };
    await runHistoricalJob(job.id, ctx);
    const stopped = await prisma.historicalJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stopped.status).toBe('CANCELLED');
    expect(stopped.scanned).toBe(100);

    // Resume (the API sets it back to QUEUED).
    await prisma.historicalJob.update({ where: { id: job.id }, data: { status: 'QUEUED' } });
    await runHistoricalJob(job.id, ctx);
    expect(await prisma.historicalJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'COMPLETED', scanned: 120, matched: 120 });
    expect(await prisma.messageRuleMatch.count()).toBe(120);
  });
});

describe('manual download from Rule Testing', () => {
  it('downloads only the selected attachments, even if the rule would skip them, and can repeat on request', async () => {
    const { mb, rule } = await setup();
    const m = fake.add(mail(1, '2026-11-12'));
    await syncMailbox(mb.id, 'AUTO', ctx); // rule auto-processes the PDF only
    await processDownloads(ctx);
    expect((await readdir(out)).sort()).toEqual(['.mailvault-tmp', 'INV-1.pdf']);

    const queued = await runManualDownload({ mailboxId: mb.id, providerMessageId: m.providerMessageId, ruleId: rule.id, attachmentIds: ['x1'], userId: 'u1' }, ctx);
    expect(queued).toBe(1);
    await processDownloads(ctx);
    expect((await readdir(out)).filter((f) => !f.startsWith('.')).sort()).toEqual(['INV-1.pdf', 'data-1.xlsx']);

    const matches = await prisma.messageRuleMatch.findMany({ orderBy: { runNumber: 'asc' } });
    expect(matches.map((x) => [x.trigger, x.runNumber])).toEqual([
      ['AUTO', 1],
      ['RULE_TEST', 2],
    ]);
  });
});
