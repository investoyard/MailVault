// The API only *sends* jobs (e.g. "Sync now"); the worker runs them. No scheduling/maintenance here.
import { PgBoss } from 'pg-boss';
import { QUEUES } from '@mailvault/shared';

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

export function getQueue(): Promise<PgBoss> {
  if (boss) return Promise.resolve(boss);
  starting ??= (async () => {
    const b = new PgBoss({
      connectionString: (process.env.DATABASE_URL ?? '').replace(/\?.*$/, ''),
      schema: 'pgboss',
      supervise: false,
      schedule: false,
    });
    b.on('error', () => undefined);
    await b.start();
    await b.createQueue(QUEUES.syncMailbox, { policy: 'stately' }).catch(() => undefined);
    await b.createQueue(QUEUES.processDownloads, { policy: 'stately' }).catch(() => undefined);
    await b.createQueue(QUEUES.workerControl).catch(() => undefined);
    boss = b;
    return b;
  })();
  return starting;
}

export async function stopQueue() {
  await boss?.stop({ graceful: false }).catch(() => undefined);
}
