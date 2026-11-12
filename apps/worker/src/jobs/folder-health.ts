import { checkFolder } from '@mailvault/core/node';
import { prisma } from '@mailvault/db';
import { log } from '../env.js';

/**
 * Checks every destination folder. Alerts only when the state changes
 * (healthy → unavailable, and again on recovery), never on every run.
 */
export async function runFolderHealth() {
  const destinations = await prisma.destination.findMany();
  for (const d of destinations) {
    const r = await checkFolder(d.basePath, d.createIfMissing, d.lowSpaceThresholdMb);
    await prisma.destination.update({
      where: { id: d.id },
      data: {
        status: r.status,
        freeSpaceMb: r.freeMb !== null ? BigInt(r.freeMb) : null,
        lastError: r.error,
        lastCheckedAt: new Date(),
      },
    });

    const alertKey = `DESTINATION:${d.id}`;
    if (r.status === 'UNAVAILABLE' && d.status !== 'UNAVAILABLE') {
      log.warn({ destination: d.name, error: r.error }, 'destination unavailable');
      await raiseAlert(alertKey, 'DESTINATION_UNAVAILABLE', 'ERROR', `Folder unavailable: ${d.name}`, `${d.basePath}: ${r.error}`);
    } else if (r.status !== 'UNAVAILABLE' && d.status === 'UNAVAILABLE') {
      log.info({ destination: d.name }, 'destination recovered');
      await resolveAlert(alertKey, `Folder available again: ${d.name}`, d.basePath);
    }
  }
}

async function adminIds() {
  const users = await prisma.user.findMany({ where: { isActive: true, role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, select: { id: true } });
  return users.map((u) => ({ userId: u.id }));
}

export async function raiseAlert(alertKey: string, type: string, severity: 'WARNING' | 'ERROR', title: string, message: string) {
  const open = await prisma.notification.findFirst({ where: { alertKey, resolvedAt: null } });
  if (open) return; // already alerted, no spam
  await prisma.notification.create({
    data: { type, severity, title, message, alertKey, link: '/destinations', recipients: { create: await adminIds() } },
  });
}

export async function resolveAlert(alertKey: string, title: string, message: string) {
  const { count } = await prisma.notification.updateMany({ where: { alertKey, resolvedAt: null }, data: { resolvedAt: new Date() } });
  if (count === 0) return;
  await prisma.notification.create({
    data: { type: 'RESOLVED', severity: 'SUCCESS', title, message, link: '/destinations', recipients: { create: await adminIds() } },
  });
}
