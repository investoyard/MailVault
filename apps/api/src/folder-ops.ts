// Destination picker requests (browse / test / new folder) are run by the WORKER, because it is the
// Windows account that actually writes the files. The API queues the request and waits for the
// job's output. If no worker is running, the API runs it itself and says so (via: 'website').
import { browseRoots, prisma } from '@mailvault/db';
import { runFolderOp, type FolderOp, type FolderOpResult } from '@mailvault/core/node';
import { QUEUES } from '@mailvault/shared';
import { getQueue } from './queue.js';

export type FolderOpReply = FolderOpResult & { via: 'worker' | 'website' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT_MS = 25_000;

/** Never throws: problems come back as { ok: false, error }. */
export async function folderOp(op: FolderOp): Promise<FolderOpReply> {
  const online = await prisma.serviceHeartbeat.count({
    where: { service: 'worker', lastBeatAt: { gt: new Date(Date.now() - 3 * 60_000) } },
  });
  if (!online) return { ...(await runFolderOp(op, await browseRoots())), via: 'website' };

  const boss = await getQueue();
  const id = await boss.send(QUEUES.folderOps, op, { retryLimit: 0, expireInSeconds: 60 });
  if (!id) return { ok: false, account: '', error: 'Could not send the request to the worker', via: 'worker' };

  const deadline = Date.now() + TIMEOUT_MS;
  for (let wait = 100; Date.now() < deadline; wait = Math.min(wait + 50, 300)) {
    await sleep(wait);
    const job = await boss.getJobById(QUEUES.folderOps, id);
    if (job?.state === 'completed' && job.output) return { ...(job.output as FolderOpResult), via: 'worker' };
    if (job?.state === 'failed' || job?.state === 'cancelled') {
      return { ok: false, account: '', error: 'The worker could not run this request. See the Processing log.', via: 'worker' };
    }
  }
  await boss.cancel(QUEUES.folderOps, id).catch(() => undefined);
  return { ok: false, account: '', error: 'The worker did not answer in time. Try again, or check System Status.', via: 'worker' };
}
