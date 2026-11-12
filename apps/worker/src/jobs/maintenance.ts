import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { prisma, raiseAlert, resolveAlert, plog } from '@mailvault/db';
import { log } from '../env.js';

const DAY = 24 * 3600_000;

/** Warns 30 days before the Microsoft 365 app certificate expires (a classic silent outage). */
export async function checkCertificate(now = new Date()) {
  const path = process.env.M365_CERT_PATH?.trim();
  if (!path) return null;
  try {
    const pem = await readFile(path, 'utf8');
    const certPem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem)?.[0];
    if (!certPem) throw new Error('No certificate found in the PEM file');
    const cert = new X509Certificate(certPem);
    const expires = new Date(cert.validTo);
    const daysLeft = Math.floor((expires.getTime() - now.getTime()) / DAY);
    if (daysLeft <= 30) {
      await raiseAlert({
        key: 'CERT_EXPIRY',
        type: 'CERT_EXPIRING',
        severity: daysLeft <= 7 ? 'ERROR' : 'WARNING',
        title: daysLeft < 0 ? 'Microsoft 365 certificate has expired' : `Microsoft 365 certificate expires in ${daysLeft} day(s)`,
        message: `The MailVault app certificate expires on ${expires.toDateString()}. Create a new one and upload it to the Entra app (see docs/ENTRA-SETUP.md), or email processing will stop.`,
        link: '/system',
      });
    } else {
      await resolveAlert('CERT_EXPIRY', 'Microsoft 365 certificate renewed', `Valid until ${expires.toDateString()}.`, '/system');
    }
    return { expires, daysLeft };
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'could not read the M365 certificate');
    return null;
  }
}

/** One alert when many downloads fail within an hour (something systemic, not one bad email). */
export async function checkRepeatedFailures(threshold = 10, now = new Date()) {
  const failed = await prisma.attachmentDownload.count({ where: { status: 'FAILED', updatedAt: { gte: new Date(now.getTime() - 3600_000) } } });
  if (failed >= threshold) {
    await raiseAlert({
      key: 'REPEATED_FAILURES',
      type: 'REPEATED_FAILURES',
      severity: 'ERROR',
      title: `${failed} downloads failed in the last hour`,
      message: 'Many downloads are failing. Check Download History (filter: Failed) and the processing logs for the common cause.',
      link: '/history?status=FAILED',
    });
  } else if (failed === 0) {
    await resolveAlert('REPEATED_FAILURES', 'Downloads are succeeding again', 'No failed downloads in the last hour.', '/history');
  }
  return failed;
}

async function settingNumber(key: string, fallback: number) {
  const row = await prisma.setting.findUnique({ where: { key } });
  return typeof row?.value === 'number' ? row.value : fallback;
}

/**
 * Nightly retention cleanup (Settings → Logs & retention). Old download details are removed, but the
 * small per-rule match records stay, so old emails are never downloaded twice by a later job.
 */
export async function runCleanup(now = new Date()) {
  const auto = await prisma.setting.findUnique({ where: { key: 'logs.autoCleanup' } });
  if (auto?.value === false) return null;
  const logsDays = Math.max(7, await settingNumber('logs.retentionDays', 90));
  const historyDays = Math.max(30, await settingNumber('history.retentionDays', 730));
  const logsBefore = new Date(now.getTime() - logsDays * DAY);
  const historyBefore = new Date(now.getTime() - historyDays * DAY);

  const [processingLogs, syncRuns, notifications, jobs, downloads, auditLogs] = await prisma.$transaction([
    prisma.processingLog.deleteMany({ where: { createdAt: { lt: logsBefore } } }),
    prisma.syncRun.deleteMany({ where: { startedAt: { lt: logsBefore } } }),
    prisma.notification.deleteMany({ where: { createdAt: { lt: logsBefore }, OR: [{ alertKey: null }, { resolvedAt: { not: null } }] } }),
    prisma.historicalJob.deleteMany({ where: { createdAt: { lt: logsBefore }, status: { in: ['COMPLETED', 'CANCELLED', 'FAILED'] } } }),
    prisma.attachmentDownload.deleteMany({ where: { createdAt: { lt: historyBefore }, status: { in: ['SUCCESS', 'SKIPPED', 'FAILED'] } } }),
    prisma.auditLog.deleteMany({ where: { createdAt: { lt: historyBefore } } }),
  ]);
  const result = {
    processingLogs: processingLogs.count,
    syncRuns: syncRuns.count,
    notifications: notifications.count,
    historicalJobs: jobs.count,
    downloads: downloads.count,
    auditLogs: auditLogs.count,
    keptMatchLedger: true,
    logsRetentionDays: logsDays,
    historyRetentionDays: historyDays,
  };
  // The cleanup itself is audited.
  await prisma.auditLog.create({ data: { action: 'RETENTION_CLEANUP', entityType: 'System', after: result } });
  const removed = result.processingLogs + result.syncRuns + result.notifications + result.historicalJobs + result.downloads + result.auditLogs;
  await plog('info', 'system', `Retention cleanup removed ${removed} old record(s)`, { data: result });
  return result;
}
