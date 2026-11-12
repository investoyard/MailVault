import { prisma } from '@mailvault/db';

async function adminRecipients() {
  const users = await prisma.user.findMany({ where: { isActive: true, role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, select: { id: true } });
  return { create: users.map((u) => ({ userId: u.id })) };
}

/** Raises an alert once per key until it is resolved (no repeated notifications for the same problem). */
export async function raiseAlert(o: { key: string; type: string; severity: 'WARNING' | 'ERROR'; title: string; message: string; link?: string }) {
  const open = await prisma.notification.findFirst({ where: { alertKey: o.key, resolvedAt: null } });
  if (open) return false;
  await prisma.notification.create({
    data: { type: o.type, severity: o.severity, title: o.title, message: o.message, alertKey: o.key, link: o.link, recipients: await adminRecipients() },
  });
  return true;
}

/** Closes an open alert and tells admins it recovered. */
export async function resolveAlert(key: string, title: string, message: string, link?: string) {
  const { count } = await prisma.notification.updateMany({ where: { alertKey: key, resolvedAt: null }, data: { resolvedAt: new Date() } });
  if (count === 0) return false;
  await prisma.notification.create({ data: { type: 'RESOLVED', severity: 'SUCCESS', title, message, link, recipients: await adminRecipients() } });
  return true;
}

export async function plog(level: 'info' | 'warn' | 'error', source: string, message: string, extra: { correlationId?: string; mailboxId?: string; data?: unknown } = {}) {
  await prisma.processingLog
    .create({ data: { level, source, message, correlationId: extra.correlationId, mailboxId: extra.mailboxId, data: extra.data as never } })
    .catch(() => undefined);
}
