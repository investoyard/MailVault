import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yazl from 'yazl';
import { prisma } from '@mailvault/db';
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
const ctx: PipelineContext = { providerFor: () => fake, settings: async () => settings, now: () => new Date() };
const dirs: string[] = [];

function zipOf(entries: Record<string, string>): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const z = new yazl.ZipFile();
    for (const [name, data] of Object.entries(entries)) z.addBuffer(Buffer.from(data), name);
    z.end();
    const chunks: Buffer[] = [];
    z.outputStream.on('data', (c: Buffer) => chunks.push(c)).on('end', () => ok(Buffer.concat(chunks))).on('error', fail);
  });
}

async function setup(attachments: object) {
  const dest = await prisma.destination.create({ data: { name: 'Out', basePath: out, status: 'HEALTHY' } });
  const mb = await prisma.mailbox.create({
    data: { email: 'zip@test.local', monitoringStartAt: new Date('2026-01-01T00:00:00Z'), folders: { create: { providerFolderId: 'inbox', displayName: 'Inbox' } } },
  });
  await prisma.rule.create({
    data: {
      name: 'Statements',
      mailboxId: mb.id,
      destinationId: dest.id,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      conditions: { senderInclude: [], senderExclude: [], recipients: [], cc: [], subjectKeywords: [], keywordMode: 'ANY', ignoreReplyPrefixes: true },
      attachments: { mode: 'SELECTED', extensions: ['pdf'], excludeNames: [], allowMultiple: true, includeInline: false, ...attachments },
      download: { destinationId: dest.id, subfolderPattern: '', fileNamePattern: '{OriginalName}', duplicatePolicy: 'SMART', autoDownload: true, setFileDateToReceived: false },
    },
  });
  return mb;
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "ExtractedFile","AttachmentDownload","Attachment","MessageRuleMatch","Message","SyncRun","RuleVersion","Rule","MailboxFolder","Mailbox","Destination","Notification","ProcessingLog" CASCADE',
  );
  fake = new FakeProvider();
  out = await mkdtemp(join(tmpdir(), 'mv-zip-'));
  dirs.push(out);
});
afterAll(async () => {
  await prisma.$disconnect();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const files = async () => (await readdir(out)).filter((f) => !f.startsWith('.')).sort();

describe('unpacking in the pipeline', () => {
  it('saves the matching files from a ZIP and records everything found inside', async () => {
    const mb = await setup({ extractArchives: true });
    const zip = await zipOf({ 'Oct/HDFC-Oct.pdf': 'oct', 'Nov/HDFC-Nov.pdf': 'nov', 'readme.txt': 'x' });
    fake.add({ from: { email: 'bank@hdfc.example' }, subject: 'Statements', receivedAt: new Date(), attachments: [{ id: 'z', name: 'statements.zip', size: zip.length, isInline: false, kind: 'file', content: zip }] });
    await syncMailbox(mb.id, 'AUTO', ctx);
    await processDownloads(ctx);

    expect(await files()).toEqual(['HDFC-Nov.pdf', 'HDFC-Oct.pdf']); // the ZIP itself is not kept by default
    expect(await readFile(join(out, 'HDFC-Oct.pdf'), 'utf8')).toBe('oct');
    const d = await prisma.attachmentDownload.findFirstOrThrow({ include: { extracted: { orderBy: { innerPath: 'asc' } } } });
    expect(d.status).toBe('SUCCESS');
    expect(d.extracted.map((x) => [x.innerPath, x.status, x.reason])).toEqual([
      ['Nov/HDFC-Nov.pdf', 'SUCCESS', null],
      ['Oct/HDFC-Oct.pdf', 'SUCCESS', null],
      ['readme.txt', 'SKIPPED', 'File type .txt not selected in rule'],
    ]);
    expect(await readdir(join(out, '.mailvault-tmp'))).toEqual([]); // temp work cleaned up
  });

  it('keeps the ZIP too when asked, and reports a damaged ZIP as a clear failure', async () => {
    const mb = await setup({ extractArchives: true, keepContainer: true });
    const zip = await zipOf({ 'a.pdf': 'a' });
    fake.add({ from: { email: 'x@y.z' }, subject: 'Good', receivedAt: new Date(), attachments: [{ id: 'g', name: 'good.zip', size: zip.length, isInline: false, kind: 'file', content: zip }] });
    fake.add({ from: { email: 'x@y.z' }, subject: 'Bad', receivedAt: new Date(), attachments: [{ id: 'b', name: 'bad.zip', size: 10, isInline: false, kind: 'file', content: 'not a zip!' }] });
    await syncMailbox(mb.id, 'AUTO', ctx);
    await processDownloads(ctx);

    expect(await files()).toEqual(['a.pdf', 'good.zip']);
    const bad = await prisma.attachmentDownload.findFirstOrThrow({ where: { attachment: { name: 'bad.zip' } } });
    expect(bad.status).toBe('FAILED');
    expect(bad.errorMessage).toMatch(/damaged or not a valid ZIP/);
  });

  it('unpacks an attached email (Outlook "attach as item") and skips the rest', async () => {
    const mb = await setup({ extractEmails: true });
    const eml = [
      'From: a@vendor.com',
      'Subject: Original',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain',
      '',
      'see attached',
      '--B',
      'Content-Type: application/pdf; name="PO-77.pdf"',
      'Content-Disposition: attachment; filename="PO-77.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('po').toString('base64'),
      '--B--',
      '',
    ].join('\r\n');
    fake.add({ from: { email: 'boss@company.com' }, subject: 'FW: PO', receivedAt: new Date(), attachments: [{ id: 'i', name: 'Original', size: eml.length, isInline: false, kind: 'item', content: eml }] });
    await syncMailbox(mb.id, 'AUTO', ctx);
    await processDownloads(ctx);
    expect(await files()).toEqual(['PO-77.pdf']);
  });

  it('without the option, a ZIP is treated like any other file', async () => {
    const mb = await setup({});
    const zip = await zipOf({ 'a.pdf': 'a' });
    fake.add({ from: { email: 'x@y.z' }, subject: 'Zip', receivedAt: new Date(), attachments: [{ id: 'z', name: 'docs.zip', size: zip.length, isInline: false, kind: 'file', content: zip }] });
    await syncMailbox(mb.id, 'AUTO', ctx);
    await processDownloads(ctx);
    expect(await files()).toEqual([]);
    expect((await prisma.attachmentDownload.findFirstOrThrow()).skipReason).toBe('File type .zip not selected in rule');
  });
});
