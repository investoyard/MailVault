// Load test against the separate "mailvault_test" database with a simulated mailbox (never touches live data).
// Usage: npx tsx test/load.ts [mailboxes=20] [emailsPerMailbox=250] [latencyMs=25] [fileKb=50]
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [MAILBOXES = 20, PER = 250, LATENCY = 25, FILE_KB = 50] = process.argv.slice(2).map(Number);
const envFile = readFileSync(resolve(import.meta.dirname, '../../../.env'), 'utf8');
const live = /^DATABASE_URL="?([^"\r\n]+)"?/m.exec(envFile)![1]!;
process.env.DATABASE_URL = live.replace(/\/mailvault(\?|$)/, '/mailvault_test$1');
process.env.LOG_LEVEL = 'silent';

const { prisma } = await import('@mailvault/db');
const { syncMailbox } = await import('../src/pipeline/sync.js');
const { processDownloads } = await import('../src/pipeline/download.js');
const { FakeProvider } = await import('./fake-provider.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
class SlowProvider extends FakeProvider {
  override async getChanges(o: Parameters<FakeProvider['getChanges']>[0]) {
    await sleep(LATENCY * 2);
    return super.getChanges(o);
  }
  override async listAttachments(r: Parameters<FakeProvider['listAttachments']>[0]) {
    await sleep(LATENCY);
    return super.listAttachments(r);
  }
  override async openAttachment(r: Parameters<FakeProvider['openAttachment']>[0], id: string) {
    await sleep(LATENCY);
    return super.openAttachment(r, id);
  }
}

let peakRss = 0;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 200);
const mb = (n: number) => Math.round(n / 1048576);

await prisma.$executeRawUnsafe(
  'TRUNCATE "AttachmentDownload","Attachment","MessageRuleMatch","Message","SyncRun","HistoricalJob","RuleVersion","Rule","MailboxFolder","Mailbox","Destination","Notification","ProcessingLog" CASCADE',
);
const out = await mkdtemp(join(tmpdir(), 'mv-load-'));
const dest = await prisma.destination.create({ data: { name: 'Load', basePath: out, status: 'HEALTHY' } });
const providers = new Map<string, InstanceType<typeof SlowProvider>>();
const content = 'x'.repeat(FILE_KB * 1024);
const now = Date.now();

console.log(`Setting up ${MAILBOXES} mailboxes × ${PER} emails (1 PDF of ${FILE_KB} KB + 1 inline logo each), simulated Graph latency ${LATENCY} ms…`);
for (let m = 0; m < MAILBOXES; m++) {
  const email = `load${m}@test.local`;
  const box = await prisma.mailbox.create({ data: { email, monitoringStartAt: new Date(now - 30 * 86_400_000), folders: { create: { providerFolderId: 'inbox', displayName: 'Inbox' } } } });
  for (const [name, kw, prio] of [['Invoices', 'invoice', 10], ['Statements', 'statement', 20]] as const) {
    await prisma.rule.create({
      data: {
        name,
        priority: prio,
        mailboxId: box.id,
        destinationId: dest.id,
        effectiveFrom: new Date(now - 60 * 86_400_000),
        conditions: { senderInclude: ['*@vendor.com'], senderExclude: [], recipients: [], cc: [], subjectKeywords: [kw], keywordMode: 'ANY', ignoreReplyPrefixes: true },
        attachments: { mode: 'SELECTED', extensions: ['pdf'], excludeNames: [], allowMultiple: true, includeInline: false },
        download: { destinationId: dest.id, subfolderPattern: `${email}\\{yyyy}\\{MM}`, fileNamePattern: '{OriginalName}', duplicatePolicy: 'SMART', autoDownload: true, setFileDateToReceived: true },
      },
    });
  }
  const p = new SlowProvider();
  for (let i = 0; i < PER; i++) {
    p.add({
      from: { email: i % 10 === 0 ? 'news@other.com' : 'billing@vendor.com' },
      subject: i % 2 ? `Invoice ${m}-${i}` : `Statement ${m}-${i}`,
      receivedAt: new Date(now - i * 60_000),
      attachments: [
        { id: `p${i}`, name: `doc-${m}-${i}.pdf`, size: FILE_KB * 1024, isInline: false, kind: 'file', content },
        { id: `l${i}`, name: 'logo.png', size: 2000, isInline: true, kind: 'file' },
      ],
    });
  }
  providers.set(box.id, p);
}

const ctx = {
  providerFor: (m: { email: string }) => [...providers.entries()].find(([id]) => id === boxIdByEmail.get(m.email))![1],
  settings: async () => ({ syncIntervalMinutes: 5, retryMaxAttempts: 5, retryIntervalsMinutes: [1], maxSizeMb: 150, blockedExtensions: ['exe'], includeInline: false, timeZone: 'Asia/Kolkata' }),
  now: () => new Date(),
};
const boxes = await prisma.mailbox.findMany();
const boxIdByEmail = new Map(boxes.map((b) => [b.email, b.id]));

// 1. Sync + rule matching, 4 mailboxes at a time (same as the worker).
let t = Date.now();
const queue = [...boxes];
let matched = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const r = await syncMailbox(b.id, "AUTO", ctx);
      matched += r.matched;
    }
  }),
);
const syncSec = (Date.now() - t) / 1000;
const emails = await prisma.message.count();

// 2. Downloads with the worker's default concurrency.
t = Date.now();
const processed = await processDownloads(ctx, { concurrency: 3 });
const dlSec = (Date.now() - t) / 1000;

// 3. Checks + typical screen queries on the larger dataset.
const success = await prisma.attachmentDownload.count({ where: { status: 'SUCCESS' } });
const skipped = await prisma.attachmentDownload.count({ where: { status: 'SKIPPED' } });
const dupMatches = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (SELECT "messageId","ruleId","runNumber" FROM "MessageRuleMatch" GROUP BY 1,2,3 HAVING count(*) > 1) d`;
let files = 0;
for (const b of boxes) for (const y of await readdir(join(out, b.email))) for (const mo of await readdir(join(out, b.email, y))) files += (await readdir(join(out, b.email, y, mo))).filter((f) => f.endsWith('.pdf')).length;
t = Date.now();
await prisma.attachmentDownload.findMany({ orderBy: { createdAt: 'desc' }, take: 25, include: { attachment: true, match: { include: { rule: true, message: { include: { mailbox: true } } } } } });
await prisma.attachmentDownload.count({ where: { match: { message: { subject: { contains: 'invoice', mode: 'insensitive' } } } } });
const historyMs = Date.now() - t;

clearInterval(sampler);
const expectedFiles = MAILBOXES * PER * 0.9; // 10% are newsletters from another sender
console.log(`
Emails synced & evaluated : ${emails} in ${syncSec.toFixed(1)} s  (${Math.round(emails / syncSec)} emails/s), ${matched} matched
Files downloaded          : ${processed} processed, ${success} saved, ${skipped} skipped in ${dlSec.toFixed(1)} s  (${(success / dlSec).toFixed(1)} files/s, ${((success * FILE_KB) / 1024 / dlSec).toFixed(1)} MB/s)
Files on disk             : ${files} (expected ${expectedFiles})
Duplicate rule matches    : ${dupMatches[0]!.n}
History page + search     : ${historyMs} ms
Peak memory (RSS)         : ${mb(peakRss)} MB
Result                    : ${files === expectedFiles && success === expectedFiles && Number(dupMatches[0]!.n) === 0 ? 'PASS' : 'FAIL'}`);

await prisma.$executeRawUnsafe('TRUNCATE "AttachmentDownload","Attachment","MessageRuleMatch","Message","SyncRun","RuleVersion","Rule","MailboxFolder","Mailbox","Destination","ProcessingLog" CASCADE');
await prisma.$disconnect();
await rm(out, { recursive: true, force: true });
