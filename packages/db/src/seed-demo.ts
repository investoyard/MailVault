// Demo data so the admin panel can be reviewed before real mailboxes are connected.
// Everything it creates uses the domain "demo.mailvault.local" or names starting with "Demo · ".
//   npm run db:seed-demo            -> (re)create demo data
//   npm run db:seed-demo -- --clear -> remove demo data only
import './load-env.js';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptSecret, newWebhookSecret, prisma } from './index.js';

const DOMAIN = 'demo.mailvault.local';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = resolve(ROOT, '.demo-output');

async function clear() {
  const mailboxes = await prisma.mailbox.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
  const ids = mailboxes.map((m) => m.id);
  await prisma.message.deleteMany({ where: { mailboxId: { in: ids } } }); // removes matches/downloads first
  await prisma.rule.deleteMany({ where: { mailboxId: { in: ids } } });
  await prisma.mailbox.deleteMany({ where: { id: { in: ids } } });
  await prisma.destination.deleteMany({ where: { name: { startsWith: 'Demo · ' } } });
  await prisma.webhook.deleteMany({ where: { name: { startsWith: 'Demo · ' } } });
  console.log(`Removed demo data (${ids.length} mailboxes).`);
}

// Deterministic pseudo-random so the demo looks the same each run.
let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;

async function main() {
  await clear();
  if (process.argv.includes('--clear')) return;

  mkdirSync(resolve(OUT, 'Invoices'), { recursive: true });
  mkdirSync(resolve(OUT, 'Statements'), { recursive: true });
  mkdirSync(resolve(OUT, 'Contracts'), { recursive: true });

  const [inv, stm, con, hr] = await Promise.all([
    prisma.destination.create({ data: { name: 'Demo · Vendor invoices', basePath: resolve(OUT, 'Invoices') } }),
    prisma.destination.create({ data: { name: 'Demo · Bank statements', basePath: resolve(OUT, 'Statements') } }),
    prisma.destination.create({ data: { name: 'Demo · Contracts', basePath: resolve(OUT, 'Contracts') } }),
    prisma.destination.create({ data: { name: 'Demo · HR archive (offline share)', basePath: 'Q:\\Archive\\HR', createIfMissing: false } }),
  ]);

  const now = Date.now();
  const mbAccounts = await prisma.mailbox.create({
    data: { email: `accounts@${DOMAIN}`, displayName: 'Accounts Payable', status: 'CONNECTED', lastSyncAt: new Date(now - 2 * 60_000), lastSuccessAt: new Date(now - 2 * 60_000), folders: { create: [{ providerFolderId: 'inbox', displayName: 'Inbox' }, { providerFolderId: 'vendors', displayName: 'Inbox/Vendors' }] } },
  });
  const mbTreasury = await prisma.mailbox.create({
    data: { email: `treasury@${DOMAIN}`, displayName: 'Treasury', status: 'CONNECTED', lastSyncAt: new Date(now - 4 * 60_000), folders: { create: { providerFolderId: 'inbox', displayName: 'Inbox' } } },
  });
  const mbHr = await prisma.mailbox.create({
    data: { email: `hr@${DOMAIN}`, displayName: 'Human Resources', status: 'REAUTH_REQUIRED', lastSyncAt: new Date(now - 26 * 3600_000), lastError: 'Sign-in expired: the mailbox owner changed their password. Reauthorize to resume.', authMode: 'DELEGATED', folders: { create: { providerFolderId: 'inbox', displayName: 'Inbox' } } },
  });

  const baseFilter = { mode: 'SELECTED', extensions: ['pdf'], allowMultiple: true, includeInline: false, excludeNames: [] };
  const mkRule = (data: { name: string; mailboxId: string; destinationId: string; priority: number; senders: string[]; subject?: string; keywords?: string[]; ext?: string[]; pattern?: string; extra?: object }) =>
    prisma.rule.create({
      data: {
        name: data.name,
        mailboxId: data.mailboxId,
        destinationId: data.destinationId,
        priority: data.priority,
        conditions: { senderInclude: data.senders, senderExclude: [], recipients: [], cc: [], subjectContains: data.subject, subjectKeywords: data.keywords ?? [], keywordMode: 'ANY', ignoreReplyPrefixes: true },
        attachments: { ...baseFilter, extensions: data.ext ?? ['pdf'] },
        download: { destinationId: data.destinationId, subfolderPattern: data.pattern ?? '', fileNamePattern: '{OriginalName}', duplicatePolicy: 'SMART', autoDownload: true },
        ...data.extra,
      },
    });

  const rules = await Promise.all([
    mkRule({ name: 'Vendor invoices', mailboxId: mbAccounts.id, destinationId: inv.id, priority: 10, senders: ['*@acme-supplies.com', '*@globex.in'], keywords: ['invoice', 'bill'], pattern: '{SenderDomain}\\{yyyy}\\{MM}' }),
    mkRule({ name: 'Credit notes', mailboxId: mbAccounts.id, destinationId: inv.id, priority: 20, senders: ['*@acme-supplies.com'], subject: 'Credit note', pattern: 'Credit notes\\{yyyy}' }),
    mkRule({ name: 'Purchase order copies', mailboxId: mbAccounts.id, destinationId: con.id, priority: 30, senders: ['procurement@globex.in'], keywords: ['PO'], ext: ['pdf', 'xlsx'], extra: { simulationMode: true } }),
    mkRule({ name: 'HDFC bank statements', mailboxId: mbTreasury.id, destinationId: stm.id, priority: 10, senders: ['statements@hdfcbank.example'], subject: 'Statement', ext: ['pdf', 'xls', 'xlsx'], pattern: 'HDFC\\{yyyy}\\{MM}', extra: { stopFurtherRules: true } }),
    mkRule({ name: 'ICICI bank statements', mailboxId: mbTreasury.id, destinationId: stm.id, priority: 20, senders: ['alerts@icicibank.example'], subject: 'Statement', ext: ['pdf', 'csv'], pattern: 'ICICI\\{yyyy}\\{MM}' }),
    mkRule({ name: 'Signed offer letters', mailboxId: mbHr.id, destinationId: hr.id, priority: 10, senders: ['*@docusign.example'], subject: 'Completed', extra: { enabled: false } }),
  ]);

  const scenarios = [
    { rule: rules[0]!, mb: mbAccounts, senders: ['billing@acme-supplies.com', 'accounts@globex.in'], subjects: ['Invoice INV-{n} for October services', 'Bill no. {n} – payment due', 'Tax invoice {n}'], files: ['INV-{n}.pdf', 'Invoice_{n}.pdf'], weight: 9 },
    { rule: rules[1]!, mb: mbAccounts, senders: ['billing@acme-supplies.com'], subjects: ['Credit note CN-{n}'], files: ['CN-{n}.pdf'], weight: 2 },
    { rule: rules[3]!, mb: mbTreasury, senders: ['statements@hdfcbank.example'], subjects: ['Your account statement for {m}'], files: ['HDFC_Statement_{n}.pdf', 'HDFC_{n}.xlsx'], weight: 4 },
    { rule: rules[4]!, mb: mbTreasury, senders: ['alerts@icicibank.example'], subjects: ['e-Statement {m}'], files: ['ICICI_{n}.pdf', 'ICICI_{n}.csv'], weight: 3 },
  ];
  const weighted = scenarios.flatMap((s) => Array(s.weight).fill(s) as (typeof s)[]);
  const months = ['Sep 2026', 'Oct 2026', 'Nov 2026'];
  const errors = [
    ['GRAPH_THROTTLED', 'Microsoft throttled the request (429). Gave up after 5 attempts.'],
    ['DEST_UNAVAILABLE', 'Destination folder was unavailable: network share unreachable.'],
    ['FILE_LOCKED', 'File is locked by another program (Excel).'],
  ];

  let n = 1000;
  for (let i = 0; i < 420; i++) {
    const s = pick(weighted);
    const ageMs = Math.pow(rnd(), 1.4) * 30 * 86400_000;
    const receivedAt = new Date(now - ageMs);
    const num = String(++n);
    const subject = pick(s.subjects).replace('{n}', num).replace('{m}', pick(months));
    const sender = pick(s.senders);
    const msg = await prisma.message.create({
      data: {
        mailboxId: s.mb.id,
        providerMessageId: `demo-${i}-${num}`,
        internetMessageId: `<${num}.${i}@${sender.split('@')[1]}>`,
        folderId: 'inbox',
        fromEmail: sender,
        fromName: sender.split('@')[1]!.split('.')[0]!.replace(/^\w/, (c) => c.toUpperCase()),
        toEmails: [s.mb.email],
        ccEmails: rnd() < 0.2 ? [`finance.lead@${DOMAIN}`] : [],
        subject,
        receivedAt,
        hasAttachments: true,
        evaluatedAt: ageMs < 90_000 && rnd() < 0.5 ? null : new Date(receivedAt.getTime() + 60_000),
        firstSeenAt: new Date(receivedAt.getTime() + 30_000),
      },
    });
    if (!msg.evaluatedAt) continue;

    const match = await prisma.messageRuleMatch.create({
      data: { messageId: msg.id, ruleId: s.rule.id, ruleVersion: 1, matchedAt: msg.evaluatedAt },
    });
    const fileCount = rnd() < 0.18 ? 2 : 1;
    const destBase = s.rule.destinationId === inv.id ? inv.basePath : stm.basePath;
    for (let f = 0; f < fileCount; f++) {
      const name = s.files[f % s.files.length]!.replace('{n}', num);
      const size = Math.round(40_000 + rnd() * 2_400_000);
      const att = await prisma.attachment.create({
        data: { messageId: msg.id, providerAttachmentId: `att-${i}-${f}`, name, sizeBytes: size, contentType: name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream' },
      });
      const r = rnd();
      const status = ageMs < 10 * 60_000 && r < 0.4 ? 'PENDING' : r < 0.86 ? 'SUCCESS' : r < 0.93 ? 'SKIPPED' : r < 0.985 ? 'FAILED' : 'RETRYING';
      const err = pick(errors);
      const at = new Date(receivedAt.getTime() + 90_000 + rnd() * 60_000);
      const yyyy = receivedAt.getFullYear();
      const mm = String(receivedAt.getMonth() + 1).padStart(2, '0');
      await prisma.attachmentDownload.create({
        data: {
          matchId: match.id,
          attachmentId: att.id,
          status,
          attempts: status === 'FAILED' ? 5 : status === 'RETRYING' ? 2 : 1,
          finalFileName: status === 'SUCCESS' ? name : null,
          destinationPath: status === 'SUCCESS' ? `${destBase}\\${sender.split('@')[1]}\\${yyyy}\\${mm}\\${name}` : null,
          downloadedAt: status === 'SUCCESS' ? at : null,
          bytesWritten: status === 'SUCCESS' ? BigInt(size) : null,
          sha256: status === 'SUCCESS' ? Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('') : null,
          skipReason: status === 'SKIPPED' ? pick(['Identical file already exists (Smart duplicate policy)', 'Inline image excluded', 'File type not selected in rule']) : null,
          errorCode: status === 'FAILED' ? err[0] : null,
          errorMessage: status === 'FAILED' ? err[1] : null,
          nextAttemptAt: status === 'RETRYING' ? new Date(now + 5 * 60_000) : null,
          createdAt: at,
          updatedAt: at,
        },
      });
    }
  }

  await prisma.processingLog.createMany({
    data: [
      { level: 'info', source: 'sync', message: `Sync completed for accounts@${DOMAIN}: 3 new emails, 2 matched`, mailboxId: mbAccounts.id },
      { level: 'warn', source: 'auth', message: `hr@${DOMAIN}: refresh token rejected (password changed). Status set to Reauthorization required.`, mailboxId: mbHr.id },
      { level: 'error', source: 'download', message: 'INV-1042.pdf failed after 5 attempts: Microsoft throttled the request (429)' },
    ],
  });

  const admins = await prisma.user.findMany({ where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, select: { id: true } });
  const recipients = { create: admins.map((a) => ({ userId: a.id })) };
  await prisma.notification.create({
    data: { type: 'MAILBOX_REAUTH_REQUIRED', severity: 'ERROR', title: `Reauthorization required: hr@${DOMAIN}`, message: 'The mailbox owner changed their password. Emails from this mailbox are not being processed.', alertKey: `MAILBOX:${mbHr.id}`, link: '/accounts', recipients },
  });
  await prisma.notification.create({
    data: { type: 'DAILY_SUMMARY', severity: 'SUCCESS', title: 'Daily summary: 38 attachments saved', message: '38 successful, 1 failed, 3 skipped across 2 mailboxes yesterday.', link: '/history', recipients, createdAt: new Date(now - 7 * 3600_000) },
  });

  await prisma.webhook.create({
    data: {
      name: 'Demo · ERP invoice inbox',
      url: 'https://erp.demo.mailvault.local/api/mailvault',
      secretEnc: encryptSecret(newWebhookSecret()),
      events: ['file.saved', 'file.failed'],
      mailboxIds: [mbAccounts.id],
      enabled: false,
    },
  });

  console.log('Demo data created: 3 mailboxes, 4 folders, 6 rules, 420 emails, 1 integration (paused).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
