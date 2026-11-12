// MailVault Worker: runs in the background as a Windows service (see scripts/install-service.ps1).
// Phase 0: heartbeat + job queue + folder health checks. Phase 1 adds mailbox sync, rule matching and downloads.
import { ROOT, env, log } from './env.js';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PgBoss } from 'pg-boss';
import { prisma } from '@mailvault/db';
import { runFolderHealth } from './jobs/folder-health.js';

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

const QUEUES = { folderHealth: 'folder-health' } as const;

async function main() {
  log.info({ instanceId, version }, 'MailVault worker starting');
  await prisma.$connect();

  // Remove heartbeats of old instances of this host so the dashboard shows one row per running worker.
  await prisma.serviceHeartbeat.deleteMany({ where: { service: 'worker', hostname: hostname(), lastBeatAt: { lt: new Date(Date.now() - 10 * 60_000) } } });
  await heartbeat();
  const beat = setInterval(() => heartbeat().catch((err) => log.error({ err }, 'heartbeat failed')), env.heartbeatSeconds * 1000);

  await boss.start();
  await boss.createQueue(QUEUES.folderHealth);
  await boss.schedule(QUEUES.folderHealth, '*/5 * * * *', {}, { tz: env.timeZone });
  await boss.work(QUEUES.folderHealth, async () => runFolderHealth());
  await runFolderHealth(); // once at start-up

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
