// MailVault Worker: runs in the background (see scripts/install-service.ps1).
// Jobs: sync scheduler → sync-mailbox (delta + rule matching) → process-downloads, plus folder health.
import { ROOT, env, log } from './env.js';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PgBoss } from 'pg-boss';
import { prisma } from '@mailvault/db';
import { QUEUES, type HistoricalJobMsg, type ManualDownloadJob, type SyncJob, type WorkerControlJob } from '@mailvault/shared';
import { runFolderHealth } from './jobs/folder-health.js';
import { defaultContext as ctx, graphConfigured } from './pipeline/context.js';
import { dueMailboxes, syncMailbox } from './pipeline/sync.js';
import { processDownloads, recoverStuckDownloads } from './pipeline/download.js';
import { runHistoricalJob, runManualDownload } from './pipeline/historical.js';
import { notifyChange } from './pipeline/alerts.js';
import { dispatchPending, dispatchWebhooks, sendDailyDigest } from '@mailvault/db';
import { checkCertificate, checkRepeatedFailures, runCleanup } from './jobs/maintenance.js';

const version = (JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const instanceId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const startedAt = new Date();
/** Exit code that tells src/supervisor.mjs to start a fresh copy straight away. */
const RESTART_EXIT_CODE = 75;
const supervised = process.env.MAILVAULT_SUPERVISED === '1';

async function heartbeat() {
  const memoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  await prisma.serviceHeartbeat.upsert({
    where: { instanceId },
    create: { instanceId, service: 'worker', hostname: hostname(), version, pid: process.pid, memoryMb, startedAt, lastBeatAt: new Date() },
    update: { memoryMb, lastBeatAt: new Date() },
  });
}

// pg-boss keeps its own tables in the "pgboss" schema of the MailVault database.
const boss = new PgBoss({ connectionString: env.databaseUrl.replace(/\?.*$/, ''), schema: 'pgboss' });
boss.on('error', (err) => log.error({ err }, 'job queue error'));

let warnedNotConfigured = false;

async function main() {
  log.info({ instanceId, version }, 'MailVault worker starting');
  await prisma.$connect();

  // Forget copies on this server that stopped reporting (killed without a clean shutdown).
  await prisma.serviceHeartbeat.deleteMany({ where: { service: 'worker', hostname: hostname(), lastBeatAt: { lt: new Date(Date.now() - 3 * 60_000) } } });
  await heartbeat();
  const beat = setInterval(() => heartbeat().catch((err) => log.error({ err }, 'heartbeat failed')), env.heartbeatSeconds * 1000);
  await recoverStuckDownloads();

  await boss.start();
  // "stately": at most one queued + one running job per key, so a mailbox is never synced twice at once.
  await boss.createQueue(QUEUES.syncMailbox, { policy: 'stately' });
  await boss.createQueue(QUEUES.processDownloads, { policy: 'stately' });
  await boss.createQueue(QUEUES.syncScheduler);
  await boss.createQueue(QUEUES.folderHealth);
  await boss.createQueue(QUEUES.historical);
  await boss.createQueue(QUEUES.manualDownload);
  await boss.createQueue('maintenance-nightly');
  await boss.createQueue('daily-digest');
  await boss.createQueue(QUEUES.workerControl);
  await boss.schedule('maintenance-nightly', '15 2 * * *', {}, { tz: env.timeZone });
  await boss.schedule('daily-digest', '0 8 * * *', {}, { tz: env.timeZone });

  await boss.schedule(QUEUES.syncScheduler, '* * * * *', {}, { tz: env.timeZone });
  await boss.schedule(QUEUES.folderHealth, '*/5 * * * *', {}, { tz: env.timeZone });

  await boss.work(QUEUES.syncScheduler, async () => {
    if (!graphConfigured()) {
      if (!warnedNotConfigured) log.warn('Microsoft 365 is not configured yet: automatic mailbox sync is paused');
      warnedNotConfigured = true;
    } else {
      for (const mailboxId of await dueMailboxes(ctx)) {
        await boss.send(QUEUES.syncMailbox, { mailboxId, trigger: 'AUTO' } satisfies SyncJob, { singletonKey: mailboxId });
      }
    }
    await boss.send(QUEUES.processDownloads, {}, { singletonKey: 'all' }); // retries that became due
    await checkRepeatedFailures().catch((err) => log.warn({ err }, 'failure check failed'));
    const sent = await dispatchPending().catch((err) => (log.warn({ err }, 'notification delivery failed'), 0));
    if (sent) log.info({ sent }, 'alert emails sent');
    await dispatchWebhooks().catch((err) => log.warn({ err }, 'webhook delivery failed'));
  });

  await boss.work('maintenance-nightly', async () => {
    const r = await runCleanup();
    log.info({ cleanup: r }, 'nightly cleanup done');
    await checkCertificate();
  });
  await boss.work('daily-digest', async () => {
    const n = await sendDailyDigest();
    if (n) log.info({ sent: n }, 'daily summaries sent');
  });
  await checkCertificate();

  await boss.work<SyncJob>(QUEUES.syncMailbox, { localConcurrency: 4 }, async ([job]) => {
    if (!job) return;
    const r = await syncMailbox(job.data.mailboxId, job.data.trigger ?? 'AUTO', ctx);
    await notifyChange('sync');
    if (r.matched > 0 || job.data.trigger !== 'AUTO') await boss.send(QUEUES.processDownloads, {}, { singletonKey: 'all' });
  });

  await boss.work(QUEUES.processDownloads, async () => {
    const n = await processDownloads(ctx);
    if (n) {
      log.info({ processed: n }, 'downloads processed');
      await dispatchWebhooks().catch((err) => log.warn({ err }, 'webhook delivery failed'));
      await notifyChange('downloads');
    }
  });

  await boss.work(QUEUES.folderHealth, async () => runFolderHealth());

  // Historical jobs: one at a time, so a large backfill never crowds out live sync.
  await boss.work<HistoricalJobMsg>(QUEUES.historical, { localConcurrency: 1 }, async ([job]) => {
    if (!job) return;
    await runHistoricalJob(job.data.jobId, ctx).finally(() => notifyChange('historical'));
    await boss.send(QUEUES.processDownloads, {}, { singletonKey: 'all' });
  });

  await boss.work<ManualDownloadJob>(QUEUES.manualDownload, async ([job]) => {
    if (!job) return;
    await runManualDownload(job.data, ctx);
    await boss.send(QUEUES.processDownloads, {}, { singletonKey: 'all' });
  });
  await runFolderHealth();

  await prisma.processingLog.create({
    data: { level: 'info', source: 'system', message: `Worker started on ${hostname()} (v${version})`, data: { instanceId } },
  });
  log.info('MailVault worker is running');

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    clearInterval(beat);
    // Graceful: lets running syncs/downloads finish (up to 20 s) before stopping.
    await boss.stop({ graceful: true, timeout: 20_000 }).catch(() => undefined);
    await prisma.serviceHeartbeat.delete({ where: { instanceId } }).catch(() => undefined);
    await prisma.$disconnect();
    process.exit(exitCode);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Restart requested from the admin panel (System Status → Restart worker).
  await boss.work<WorkerControlJob>(QUEUES.workerControl, async ([job]) => {
    if (!job || job.data.action !== 'restart') return;
    // A request older than this process (e.g. sent while the worker was down) is already satisfied.
    if (job.data.requestedAt < startedAt.getTime()) return;
    if (!supervised) {
      log.warn('restart requested, but this worker was not started by the MailVault service; restart it by hand');
      await prisma.processingLog.create({
        data: { level: 'warn', source: 'system', message: 'Restart requested, but this worker was not started by the MailVault service (npm run start:worker). Restart it by hand.', data: { instanceId } },
      });
      return;
    }
    log.info({ requestedBy: job.data.requestedBy }, 'restart requested from the admin panel');
    await prisma.processingLog.create({
      data: { level: 'info', source: 'system', message: `Worker restart requested by ${job.data.requestedBy}`, data: { instanceId } },
    });
    // Let pg-boss mark this job done first, then stop gracefully; the supervisor starts a fresh copy.
    setTimeout(() => void shutdown('restart', RESTART_EXIT_CODE), 1_000);
  });
}

process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled rejection'));
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception - exiting so the service restarts cleanly');
  process.exit(1);
});

main().catch((err) => {
  log.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
