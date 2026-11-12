// The worker can't report its own death, so the API watches its heartbeat and raises the alert.
// It also delivers pending notifications, so "service stopped" still reaches people by email/Teams.
import type { FastifyInstance } from 'fastify';
import { dispatchPending, prisma, raiseAlert, resolveAlert } from '@mailvault/db';

const STALE_MS = 3 * 60_000;
const startedAt = Date.now();

export async function checkWorker(now = Date.now()) {
  if (now - startedAt < STALE_MS) return 'starting'; // give the worker time after a server reboot
  const beat = await prisma.serviceHeartbeat.findFirst({ where: { service: 'worker' }, orderBy: { lastBeatAt: 'desc' } });
  const online = !!beat && now - beat.lastBeatAt.getTime() < STALE_MS;
  if (!online) {
    await raiseAlert({
      key: 'SERVICE:worker',
      type: 'SERVICE_STOPPED',
      severity: 'ERROR',
      title: 'Processing service stopped',
      message: beat
        ? `The MailVault Worker on ${beat.hostname} last reported ${Math.round((now - beat.lastBeatAt.getTime()) / 60_000)} minute(s) ago. No emails are being processed. Check the MailVault-Worker task and logs\\worker.log.`
        : 'The MailVault Worker has not started. No emails are being processed. Start the MailVault-Worker task.',
      link: '/system',
    });
  } else {
    await resolveAlert('SERVICE:worker', 'Processing service running again', `Worker on ${beat.hostname} is reporting normally.`, '/system');
  }
  return online ? 'online' : 'offline';
}

export function startWatchdog(app: FastifyInstance) {
  const tick = async () => {
    try {
      await checkWorker();
      await dispatchPending();
    } catch (err) {
      app.log.warn({ err }, 'watchdog check failed');
    }
  };
  const timer = setInterval(() => void tick(), 60_000);
  app.addHook('onClose', async () => clearInterval(timer));
}
