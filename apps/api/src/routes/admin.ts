import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@mailvault/db';
import { requireAuth, requirePermission } from '../auth.js';
import { audit } from './resources.js';

export async function adminRoutes(app: FastifyInstance) {
  // ─────────── Notifications (per signed-in user) ───────────
  app.get('/notifications', { preHandler: requireAuth }, async (req) => {
    const rows = await prisma.notificationRecipient.findMany({
      where: { userId: req.user.id },
      orderBy: { notification: { createdAt: 'desc' } },
      take: 100,
      include: { notification: true },
    });
    return rows.map((r) => ({ ...r.notification, readAt: r.readAt }));
  });

  app.post('/notifications/read-all', { preHandler: requireAuth }, async (req) => {
    await prisma.notificationRecipient.updateMany({
      where: { userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  });

  // ─────────── Logs ───────────
  const pageQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(10).max(200).default(50),
    search: z.string().trim().optional(),
  });

  app.get('/logs/audit', { preHandler: requirePermission('logs') }, async (req) => {
    const q = pageQuery.parse(req.query);
    const where = q.search
      ? {
          OR: [
            { action: { contains: q.search, mode: 'insensitive' as const } },
            { entityType: { contains: q.search, mode: 'insensitive' as const } },
          ],
        }
      : {};
    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { user: { select: { username: true, displayName: true } } },
      }),
    ]);
    return { total, rows };
  });

  app.get('/logs/processing', { preHandler: requirePermission('logs') }, async (req) => {
    const q = pageQuery.extend({ correlationId: z.string().optional(), level: z.string().optional() }).parse(req.query);
    const where = {
      correlationId: q.correlationId,
      level: q.level,
      message: q.search ? { contains: q.search, mode: 'insensitive' as const } : undefined,
    };
    const [total, rows] = await Promise.all([
      prisma.processingLog.count({ where }),
      prisma.processingLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { total, rows };
  });

  // ─────────── Users ───────────
  app.get('/users', { preHandler: requirePermission('users') }, async () =>
    prisma.user.findMany({
      orderBy: { username: 'asc' },
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        entraObjectId: true,
        _count: { select: { mailboxAccess: true } },
      },
    }),
  );

  // ─────────── Settings ───────────
  app.get('/settings', { preHandler: requirePermission('settings') }, async () => {
    const rows = await prisma.setting.findMany({ orderBy: { key: 'asc' } });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });

  app.put('/settings', { preHandler: requirePermission('settings', 'edit') }, async (req) => {
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    const existing = await prisma.setting.findMany({ where: { key: { in: Object.keys(body) } } });
    const known = new Set(existing.map((s) => s.key));
    const unknown = Object.keys(body).filter((k) => !known.has(k));
    if (unknown.length) return { error: `Unknown setting(s): ${unknown.join(', ')}` };

    await prisma.$transaction(
      Object.entries(body).map(([key, value]) =>
        prisma.setting.update({ where: { key }, data: { value: value as never, updatedBy: req.user.username } }),
      ),
    );
    await audit(
      req.user.id,
      'SETTINGS_UPDATED',
      'Setting',
      null,
      Object.fromEntries(existing.map((s) => [s.key, s.value])),
      body,
      req.ip,
    );
    return { ok: true };
  });

  // ─────────── System status ───────────
  app.get('/system/status', { preHandler: requireAuth }, async () => {
    const beats = await prisma.serviceHeartbeat.findMany({ orderBy: { lastBeatAt: 'desc' } });
    const [db] = await prisma.$queryRaw<{ size: string }[]>`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`;
    const size = db?.size ?? 'unknown';
    return {
      api: { ok: true, version: '0.1.0', node: process.version, uptimeSec: Math.round(process.uptime()) },
      database: { ok: true, size },
      workers: beats.map((b) => ({ ...b, online: Date.now() - b.lastBeatAt.getTime() < 3 * 60_000 })),
      graphConfigured: Boolean(process.env.M365_TENANT_ID && process.env.M365_CLIENT_ID),
    };
  });
}
