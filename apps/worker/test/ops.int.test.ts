import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { delivery, dispatchPending, prisma, raiseAlert, resolveAlert, sendDailyDigest } from '@mailvault/db';
import { checkRepeatedFailures, runCleanup } from '../src/jobs/maintenance.js';
import { checkWorker } from '../../api/src/watchdog.js';

type Sent = { to: string; subject: string; text: string };
let sent: Sent[] = [];
let teams: unknown[] = [];
delivery.createTransport = () => ({ sendMail: async (m: Sent) => void sent.push(m) }) as never;
delivery.postTeams = async (_url: string, body: unknown) => void teams.push(body);

async function reset() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AttachmentDownload","Attachment","MessageRuleMatch","Message","SyncRun","HistoricalJob","RuleVersion","Rule","MailboxFolder","Mailbox","Destination","NotificationRecipient","Notification","ProcessingLog","AuditLog","ServiceHeartbeat","UserMailboxAccess","User" CASCADE',
  );
  await prisma.setting.upsert({
    where: { key: 'notifications.smtp' },
    create: { key: 'notifications.smtp', value: { enabled: true, host: 'smtp.test', port: 25, secure: false, user: '', from: 'mv@test.local' } },
    update: { value: { enabled: true, host: 'smtp.test', port: 25, secure: false, user: '', from: 'mv@test.local' } },
  });
  await prisma.setting.upsert({ where: { key: 'notifications.teams.enabled' }, create: { key: 'notifications.teams.enabled', value: true }, update: { value: true } });
}

beforeEach(async () => {
  await reset();
  sent = [];
  teams = [];
  process.env.TEAMS_WEBHOOK_URL = 'https://example.invalid/webhook';
});
afterAll(async () => {
  await reset();
  await prisma.setting.deleteMany({ where: { key: { in: ['notifications.smtp', 'notifications.teams.enabled'] } } });
  await prisma.$disconnect();
});

const user = (username: string, prefs: object | null, role: 'SUPER_ADMIN' | 'ADMIN' | 'VIEWER' = 'ADMIN', email: string | null = `${username}@test.local`) =>
  prisma.user.create({ data: { username, displayName: username, role, email, notificationPrefs: prefs ?? undefined } });

describe('alert delivery', () => {
  it('emails instant subscribers by severity, skips daily/off/no-email users, posts to Teams once, never twice', async () => {
    await user('instant', null); // defaults: email on, instant, warnings and errors
    await user('errorsonly', { email: true, digest: 'instant', minSeverity: 'ERROR' });
    await user('daily', { email: true, digest: 'daily', minSeverity: 'INFO' });
    await user('off', { email: true, digest: 'off', minSeverity: 'INFO' });
    await user('noemail', null, 'ADMIN', null);
    await user('viewer', null, 'VIEWER'); // viewers are not alert recipients

    await raiseAlert({ key: 'K1', type: 'DESTINATION_LOW_SPACE', severity: 'WARNING', title: 'Low disk space', message: 'x' });
    await raiseAlert({ key: 'K1', type: 'DESTINATION_LOW_SPACE', severity: 'WARNING', title: 'Low disk space', message: 'x' }); // deduplicated
    await raiseAlert({ key: 'K2', type: 'SERVICE_STOPPED', severity: 'ERROR', title: 'Processing service stopped', message: 'y' });

    expect(await dispatchPending()).toBe(2);
    const byUser = Object.fromEntries(sent.map((m) => [m.to, m]));
    expect(Object.keys(byUser).sort()).toEqual(['errorsonly@test.local', 'instant@test.local']);
    expect(byUser['instant@test.local']!.subject).toBe('MailVault: 2 new alerts');
    expect(byUser['errorsonly@test.local']!.subject).toBe('MailVault: Processing service stopped');
    expect(teams).toHaveLength(2);

    expect(await dispatchPending()).toBe(0); // already delivered
    expect(sent).toHaveLength(2);

    await resolveAlert('K2', 'Processing service running again', 'ok');
    await dispatchPending();
    expect(sent.at(-1)!.to).toBe('instant@test.local'); // recoveries go to warning-level subscribers, not errors-only
    expect(teams).toHaveLength(3);
  });

  it('does nothing when SMTP is switched off', async () => {
    await prisma.setting.update({ where: { key: 'notifications.smtp' }, data: { value: { enabled: false, host: 'smtp.test', port: 25, secure: false, user: '', from: 'mv@test.local' } } });
    await user('instant', null);
    await raiseAlert({ key: 'K', type: 'X', severity: 'ERROR', title: 't', message: 'm' });
    expect(await dispatchPending()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('daily digest goes only to daily subscribers', async () => {
    await user('daily', { email: true, digest: 'daily', minSeverity: 'WARNING' });
    await user('instant', null);
    await raiseAlert({ key: 'K', type: 'X', severity: 'ERROR', title: 'Something failed', message: 'm' });
    expect(await sendDailyDigest()).toBe(1);
    expect(sent[0]!.to).toBe('daily@test.local');
    expect(sent[0]!.text).toContain('Something failed');
    expect(sent[0]!.text).toContain('attachment(s) saved');
  });
});

describe('watchdog and failure alerts', () => {
  it('raises "processing service stopped" once when the heartbeat is stale, resolves when it returns', async () => {
    await user('admin', null, 'SUPER_ADMIN');
    const later = Date.now() + 10 * 60_000; // past the start-up grace period
    await prisma.serviceHeartbeat.create({
      data: { instanceId: 'w1', service: 'worker', hostname: 'SRV', version: '1', pid: 1, memoryMb: 100, startedAt: new Date(), lastBeatAt: new Date(Date.now() - 60_000) },
    });
    expect(await checkWorker(later)).toBe('offline');
    expect(await checkWorker(later)).toBe('offline');
    expect(await prisma.notification.count({ where: { type: 'SERVICE_STOPPED' } })).toBe(1);

    await prisma.serviceHeartbeat.update({ where: { instanceId: 'w1' }, data: { lastBeatAt: new Date(later) } });
    expect(await checkWorker(later)).toBe('online');
    expect(await prisma.notification.count({ where: { type: 'RESOLVED' } })).toBe(1);
  });

  it('alerts on many failures in an hour and clears when they stop', async () => {
    await user('admin', null, 'SUPER_ADMIN');
    const dest = await prisma.destination.create({ data: { name: 'D', basePath: 'D:\\x' } });
    const mb = await prisma.mailbox.create({ data: { email: 'f@test.local' } });
    const rule = await prisma.rule.create({ data: { name: 'R', mailboxId: mb.id, destinationId: dest.id, conditions: {}, attachments: {}, download: {} } });
    const msg = await prisma.message.create({ data: { mailboxId: mb.id, providerMessageId: 'm', fromEmail: 'a@b.c', subject: 's', receivedAt: new Date(), hasAttachments: true } });
    const match = await prisma.messageRuleMatch.create({ data: { messageId: msg.id, ruleId: rule.id, ruleVersion: 1 } });
    for (let i = 0; i < 10; i++) {
      const a = await prisma.attachment.create({ data: { messageId: msg.id, providerAttachmentId: `a${i}`, name: `f${i}.pdf`, sizeBytes: 1 } });
      await prisma.attachmentDownload.create({ data: { matchId: match.id, attachmentId: a.id, status: 'FAILED' } });
    }
    expect(await checkRepeatedFailures(10)).toBe(10);
    expect(await prisma.notification.count({ where: { type: 'REPEATED_FAILURES', resolvedAt: null } })).toBe(1);
    await prisma.attachmentDownload.updateMany({ data: { status: 'SUCCESS' } });
    expect(await checkRepeatedFailures(10)).toBe(0);
    expect(await prisma.notification.count({ where: { type: 'REPEATED_FAILURES', resolvedAt: null } })).toBe(0);
  });
});

describe('retention cleanup', () => {
  it('removes old details, keeps the match ledger, and audits itself', async () => {
    const dest = await prisma.destination.create({ data: { name: 'D', basePath: 'D:\\x' } });
    const mb = await prisma.mailbox.create({ data: { email: 'c@test.local' } });
    const rule = await prisma.rule.create({ data: { name: 'R', mailboxId: mb.id, destinationId: dest.id, conditions: {}, attachments: {}, download: {} } });
    const old = new Date(Date.now() - 1000 * 24 * 3600_000); // ~3 years ago
    const msg = await prisma.message.create({ data: { mailboxId: mb.id, providerMessageId: 'old', fromEmail: 'a@b.c', subject: 's', receivedAt: old, hasAttachments: true } });
    const match = await prisma.messageRuleMatch.create({ data: { messageId: msg.id, ruleId: rule.id, ruleVersion: 1, matchedAt: old } });
    const a = await prisma.attachment.create({ data: { messageId: msg.id, providerAttachmentId: 'a', name: 'f.pdf', sizeBytes: 1 } });
    await prisma.attachmentDownload.create({ data: { matchId: match.id, attachmentId: a.id, status: 'SUCCESS', createdAt: old } });
    await prisma.processingLog.createMany({ data: [{ level: 'info', source: 't', message: 'old', createdAt: old }, { level: 'info', source: 't', message: 'new' }] });

    const r = await runCleanup();
    expect(r).toMatchObject({ downloads: 1, processingLogs: 1, keptMatchLedger: true });
    expect(await prisma.messageRuleMatch.count()).toBe(1); // the email stays "processed" for this rule
    expect(await prisma.processingLog.count({ where: { message: 'new' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'RETENTION_CLEANUP' } })).toBe(1);
  });
});
