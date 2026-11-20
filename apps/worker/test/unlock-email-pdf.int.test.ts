import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, openAsBlob } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobReader, BlobWriter, TextReader, ZipReader, ZipWriter } from '@zip.js/zip.js';
import { encryptSecret, prisma } from '@mailvault/db';
import { syncMailbox } from '../src/pipeline/sync.js';
import { processDownloads } from '../src/pipeline/download.js';
import { closeEmailPdfBrowser } from '../src/pipeline/email-pdf.js';
import type { PipelineContext, PipelineSettings } from '../src/pipeline/context.js';
import { FakeProvider } from './fake-provider.js';

process.env.SECRET_ENC_KEY ||= randomBytes(32).toString('base64');
process.env.QPDF_PATH ||= 'D:/Investoyard/.tools/qpdf/bin/qpdf.exe';
const hasEdge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].some((p) => existsSync(p));

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

async function protectedZip(files: Record<string, string>, password: string): Promise<Buffer> {
  const w = new ZipWriter(new BlobWriter('application/zip'), { password, zipCrypto: true });
  for (const [name, text] of Object.entries(files)) await w.add(name, new TextReader(text));
  return Buffer.from(await (await w.close()).arrayBuffer());
}

async function zipEntries(path: string) {
  const r = new ZipReader(new BlobReader(await openAsBlob(path)));
  const list = (await r.getEntries()).map((e) => ({ name: e.filename, encrypted: e.encrypted }));
  await r.close();
  return list;
}

async function setup(download: object, attachments: object = {}, passwords?: string[]) {
  const dest = await prisma.destination.create({ data: { name: 'Out', basePath: out, status: 'HEALTHY' } });
  const mb = await prisma.mailbox.create({
    data: { email: 'aif@test.local', monitoringStartAt: new Date('2026-01-01T00:00:00Z'), folders: { create: { providerFolderId: 'inbox', displayName: 'Inbox' } } },
  });
  const rule = await prisma.rule.create({
    data: {
      name: 'Statements',
      mailboxId: mb.id,
      destinationId: dest.id,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      conditions: { senderInclude: [], senderExclude: [], recipients: [], cc: [], subjectKeywords: [], keywordMode: 'ANY', ignoreReplyPrefixes: true },
      attachments: { mode: 'ALL', extensions: [], excludeNames: [], allowMultiple: true, includeInline: false, ...attachments },
      download: { destinationId: dest.id, subfolderPattern: '', fileNamePattern: '{OriginalName}', duplicatePolicy: 'SMART', autoDownload: true, setFileDateToReceived: false, ...download },
      filePasswords: passwords ? encryptSecret(JSON.stringify(passwords)) : null,
      filePasswordCount: passwords?.length ?? 0,
    },
  });
  return { mb, rule };
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "ExtractedFile","AttachmentDownload","Attachment","MessageRuleMatch","Message","SyncRun","RuleVersion","Rule","MailboxFolder","Mailbox","Destination","Notification","ProcessingLog" CASCADE',
  );
  fake = new FakeProvider();
  out = await mkdtemp(join(tmpdir(), 'mv-unlock-'));
  dirs.push(out);
});
afterAll(async () => {
  await closeEmailPdfBrowser();
  await prisma.$disconnect();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const files = async () => (await readdir(out)).filter((f) => !f.startsWith('.')).sort();

describe('removing passwords in the pipeline', () => {
  it('saves a protected ZIP as the same ZIP without a password', async () => {
    const { mb } = await setup({ unlockProtected: true }, {}, ['old-pw', 'Orient#2026']);
    const zip = await protectedZip({ 'Statement.csv': 'a,b', 'Journal.csv': 'c,d' }, 'Orient#2026');
    fake.add({ from: { email: 'ops@broker.example' }, subject: 'Daily statement', receivedAt: new Date(), attachments: [{ id: 'z', name: 'Client Daily Statement.zip', size: zip.length, isInline: false, kind: 'file', content: zip }] });
    await syncMailbox(mb.id, 'AUTO', ctx);
    await processDownloads(ctx);

    expect(await files()).toEqual(['Client Daily Statement.zip']);
    expect(await zipEntries(join(out, 'Client Daily Statement.zip'))).toEqual([
      { name: 'Statement.csv', encrypted: false },
      { name: 'Journal.csv', encrypted: false },
    ]);
    const d = await prisma.attachmentDownload.findFirstOrThrow();
    expect(d).toMatchObject({ status: 'SUCCESS', protection: 'UNLOCKED' });
  });

  it('keeps the locked file when no password works, then Retry replaces it with an unlocked copy', async () => {
    const { mb, rule } = await setup({ unlockProtected: true }, {}, ['wrong']);
    const zip = await protectedZip({ 'a.csv': 'x' }, 'right');
    fake.add({ from: { email: 'ops@broker.example' }, subject: 'Daily', receivedAt: new Date(), attachments: [{ id: 'z', name: 'daily.zip', size: zip.length, isInline: false, kind: 'file', content: zip }] });
    await syncMailbox(mb.id, 'AUTO', ctx);
    await processDownloads(ctx);

    expect(await files()).toEqual(['daily.zip']);
    expect((await zipEntries(join(out, 'daily.zip')))[0]!.encrypted).toBe(true);
    let d = await prisma.attachmentDownload.findFirstOrThrow();
    expect(d).toMatchObject({ status: 'SUCCESS', protection: 'STILL_LOCKED' });
    const alert = await prisma.notification.findFirstOrThrow({ where: { alertKey: `UNLOCK:${rule.id}` } });
    expect(alert.resolvedAt).toBeNull();

    // Admin fixes the password and presses Retry (what POST /history/:id/retry does).
    await prisma.rule.update({ where: { id: rule.id }, data: { filePasswords: encryptSecret(JSON.stringify(['right'])), filePasswordCount: 1 } });
    await prisma.attachmentDownload.update({ where: { id: d.id }, data: { status: 'PENDING', attempts: 0 } });
    await processDownloads(ctx);

    expect(await files()).toEqual(['daily.zip']); // replaced, no "daily (1).zip"
    expect((await zipEntries(join(out, 'daily.zip')))[0]!.encrypted).toBe(false);
    d = await prisma.attachmentDownload.findFirstOrThrow();
    expect(d).toMatchObject({ status: 'SUCCESS', protection: 'UNLOCKED' });
    expect((await prisma.notification.findFirstOrThrow({ where: { alertKey: `UNLOCK:${rule.id}` } })).resolvedAt).not.toBeNull();
  });

  it('unpacks a protected ZIP when the rule unpacks ZIP files', async () => {
    const { mb } = await setup({ unlockProtected: true }, { mode: 'SELECTED', extensions: ['csv'], extractArchives: true }, ['pw']);
    const zip = await protectedZip({ 'Statement.csv': 'a,b' }, 'pw');
    fake.add({ from: { email: 'ops@broker.example' }, subject: 'Daily', receivedAt: new Date(), attachments: [{ id: 'z', name: 'daily.zip', size: zip.length, isInline: false, kind: 'file', content: zip }] });
    await syncMailbox(mb.id, 'AUTO', ctx);
    await processDownloads(ctx);
    expect(await files()).toEqual(['Statement.csv']);
    expect(await readFile(join(out, 'Statement.csv'), 'utf8')).toBe('a,b');
  });

  it('leaves files alone when the rule does not remove passwords', async () => {
    const { mb } = await setup({});
    const zip = await protectedZip({ 'a.csv': 'x' }, 'pw');
    fake.add({ from: { email: 'ops@broker.example' }, subject: 'Daily', receivedAt: new Date(), attachments: [{ id: 'z', name: 'daily.zip', size: zip.length, isInline: false, kind: 'file', content: zip }] });
    await syncMailbox(mb.id, 'AUTO', ctx);
    await processDownloads(ctx);
    expect((await zipEntries(join(out, 'daily.zip')))[0]!.encrypted).toBe(true);
    expect((await prisma.attachmentDownload.findFirstOrThrow()).protection).toBeNull();
  });
});

describe.skipIf(!hasEdge)('saving the email as PDF', () => {
  it('saves only the email as PDF, also for emails without attachments', async () => {
    const { mb } = await setup({ emailPdf: 'ONLY', emailPdfNamePattern: '{Date:yyyy-MM-dd}_{Subject}' });
    fake.add({
      from: { email: 'ops@broker.example', name: 'Broker Ops' },
      subject: 'Trade confirmation 15/11',
      receivedAt: new Date('2026-11-15T06:00:00Z'),
      body: '<html><body><h2>Trades</h2><table><tr><td>INFY</td><td>100</td></tr></table><script>alert(1)</script></body></html>',
      attachments: [],
    });
    fake.add({
      from: { email: 'ops@broker.example' },
      subject: 'Note',
      receivedAt: new Date('2026-11-15T07:00:00Z'),
      body: 'Plain text body',
      attachments: [{ id: 'a', name: 'note.pdf', size: 3, isInline: false, kind: 'file', content: Buffer.from('pdf') }],
    });
    await syncMailbox(mb.id, 'AUTO', ctx);
    await processDownloads(ctx);

    expect(await files()).toEqual(['2026-11-15_Note.pdf', '2026-11-15_Trade confirmation 15_11.pdf']);
    const pdf = await readFile(join(out, '2026-11-15_Trade confirmation 15_11.pdf'));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const rows = await prisma.attachmentDownload.findMany({ include: { attachment: true }, orderBy: { createdAt: 'asc' } });
    const skipped = rows.find((r) => r.attachment.name === 'note.pdf')!;
    expect(skipped).toMatchObject({ status: 'SKIPPED', skipReason: 'This rule saves only the email as PDF' });
    expect(rows.filter((r) => r.attachment.kind === 'EMAIL_BODY' && r.status === 'SUCCESS')).toHaveLength(2);
  }, 90_000);

  it('saves the email PDF next to the attachments', async () => {
    const { mb } = await setup({ emailPdf: 'ALSO' });
    fake.add({ from: { email: 'ops@broker.example' }, subject: 'Invoice', receivedAt: new Date('2026-11-16T06:00:00Z'), body: 'See attached', attachments: [{ id: 'a', name: 'inv.pdf', size: 3, isInline: false, kind: 'file', content: Buffer.from('pdf') }] });
    await syncMailbox(mb.id, 'AUTO', ctx);
    await processDownloads(ctx);
    expect(await files()).toEqual(['20261116_Invoice.pdf', 'inv.pdf']);
  }, 90_000);
});
