// MailVault Worker: runs in the background (see scripts/install-service.ps1).
// Jobs: sync scheduler → sync-mailbox (delta + rule matching) → process-downloads, plus folder health.
import { ROOT, env, log } from './env.js';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PgBoss } from 'pg-boss';
import { prisma } from '@mailvault/db';
import { QUEUES, type HistoricalJobMsg, type ManualDownloadJob, type SyncJob } from '@mailvault/shared';
import { runFolderHealth } from './jobs/folder-health.js';
import { defaultContext as ctx, graphConfigured } from './pipeline/context.js';
import { dueMailboxes, syncMailbox } from './pipeline/sync.js';
import { processDownloads, recoverStuckDownloads } from './pipeline/download.js';
import { runHistoricalJob, runManualDownload } from './pipeline/historical.js';
import { notifyChange } from './pipeline/alerts.js';

const version = (JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const instanceId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const startedAt = new Date();

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

  await prisma.serviceHeartbeat.deleteMany({ where: { service: 'worker', hostname: hostname(), lastBeatAt: { lt: new Date(Date.now() - 10 * 60_000) } } });
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
  });

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

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    clearInterval(beat);
    await boss.stop({ graceful: true, timeout: 20_000 }).catch(() => undefined);
    await prisma.serviceHeartbeat.delete({ where: { instanceId } }).catch(() => undefined);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
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
