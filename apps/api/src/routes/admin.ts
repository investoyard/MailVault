import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, sendTestEmail, smtpSettings, type Prisma } from '@mailvault/db';
import { requireAuth, requirePermission } from '../auth.js';
import { audit } from './resources.js';
import { normalizeFolderPath } from '@mailvault/core/node';
import { getQueue } from '../queue.js';
import { QUEUES, type WorkerControlJob } from '@mailvault/shared';

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

  const auditQuery = pageQuery.extend({
    userId: z.string().optional(),
    action: z.string().optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  });
  const auditWhere = (q: z.infer<typeof auditQuery>): Prisma.AuditLogWhereInput => ({
    userId: q.userId === 'system' ? null : q.userId,
    action: q.action,
    createdAt: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined,
    ...(q.search
      ? { OR: [{ action: { contains: q.search, mode: 'insensitive' } }, { entityType: { contains: q.search, mode: 'insensitive' } }, { entityId: { contains: q.search } }] }
      : {}),
  });

  app.get('/logs/audit/actions', { preHandler: requirePermission('logs') }, async () => {
    const rows = await prisma.auditLog.groupBy({ by: ['action'], _count: { _all: true }, orderBy: { action: 'asc' } });
    return rows.map((r) => ({ action: r.action, count: r._count._all }));
  });

  app.get('/logs/audit/export', { preHandler: requirePermission('logs') }, async (req, reply) => {
    const q = auditQuery.parse(req.query);
    const ExcelJS = (await import('exceljs')).default;
    reply.raw.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="MailVault-audit-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    });
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: reply.raw, useStyles: true });
    const ws = wb.addWorksheet('Audit trail', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'When (UTC)', key: 'at', width: 20, style: { numFmt: 'dd-mmm-yyyy hh:mm:ss' } },
      { header: 'User', key: 'user', width: 24 },
      { header: 'Action', key: 'action', width: 28 },
      { header: 'Entity', key: 'entity', width: 18 },
      { header: 'Entity ID', key: 'entityId', width: 28 },
      { header: 'IP', key: 'ip', width: 16 },
      { header: 'Before', key: 'before', width: 60 },
      { header: 'After', key: 'after', width: 60 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3C2E7E' } };
    ws.getRow(1).commit();
    let cursor: string | undefined;
    let written = 0;
    for (;;) {
      const batch = await prisma.auditLog.findMany({
        where: auditWhere(q),
        orderBy: { id: 'asc' },
        take: 1000,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        include: { user: { select: { displayName: true } } },
      });
      for (const r of batch) {
        ws.addRow({
          at: r.createdAt,
          user: r.user?.displayName ?? 'System',
          action: r.action,
          entity: r.entityType ?? '',
          entityId: r.entityId ?? '',
          ip: r.ip ?? '',
          before: r.before ? JSON.stringify(r.before).slice(0, 32_000) : '',
          after: r.after ? JSON.stringify(r.after).slice(0, 32_000) : '',
        }).commit();
      }
      written += batch.length;
      if (batch.length < 1000 || written >= 200_000) break;
      cursor = batch.at(-1)!.id;
    }
    await wb.commit();
    await audit(req.user.id, 'AUDIT_EXPORTED', 'AuditLog', null, null, { rows: written }, req.ip);
    return reply;
  });

  app.get('/logs/audit', { preHandler: requirePermission('logs') }, async (req) => {
    const q = auditQuery.parse(req.query);
    const where = auditWhere(q);
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

  // ─────────── Settings ───────────
  app.get('/settings', { preHandler: requirePermission('settings') }, async () => {
    const rows = await prisma.setting.findMany({ orderBy: { key: 'asc' } });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });

  app.put('/settings', { preHandler: requirePermission('settings', 'edit') }, async (req, reply) => {
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    if ('destinations.browseRoots' in body) {
      const roots = z.array(z.string()).nullish().parse(body['destinations.browseRoots']) ?? [];
      try {
        body['destinations.browseRoots'] = [...new Set(roots.map((r) => r.trim()).filter(Boolean).map(normalizeFolderPath))];
      } catch (err) {
        return reply.code(400).send({ error: `Allowed locations: ${(err as Error).message}` });
      }
    }
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
      certificate: await certificateInfo(),
      notifications: {
        email: (await smtpSettings()).enabled,
        teams: Boolean(process.env.TEAMS_WEBHOOK_URL?.trim()) && (await prisma.setting.findUnique({ where: { key: 'notifications.teams.enabled' } }))?.value === true,
      },
    };
  });

  // Asks the worker to restart (finishes running jobs, then the supervisor starts a fresh copy that
  // re-reads .env). Super Admin only by default (system:execute).
  app.post('/system/worker/restart', { preHandler: requirePermission('system', 'execute') }, async (req, reply) => {
    const online = await prisma.serviceHeartbeat.findMany({
      where: { service: 'worker', lastBeatAt: { gt: new Date(Date.now() - 3 * 60_000) } },
    });
    if (!online.length) {
      return reply.code(409).send({
        error: 'The worker is not running, so it cannot be restarted from here. Start the MailVault-Worker task on the server (scripts\\install-service.ps1).',
      });
    }
    const requestedAt = Date.now();
    const boss = await getQueue();
    await boss.send(
      QUEUES.workerControl,
      { action: 'restart', requestedAt, requestedBy: req.user.username } satisfies WorkerControlJob,
      { retryLimit: 0, expireInSeconds: 120 },
    );
    await audit(req.user.id, 'WORKER_RESTART_REQUESTED', 'System', null, null, { instances: online.map((w) => w.instanceId) }, req.ip);
    return { ok: true, requestedAt, message: 'Restart requested. The worker finishes what it is doing and is back within about a minute.' };
  });

  // Sends a test email with the SMTP settings from the form (before or after saving them).
  app.post('/settings/test-email', { preHandler: requirePermission('settings', 'edit') }, async (req, reply) => {
    const b = z
      .object({
        to: z.email(),
        smtp: z.object({ enabled: z.boolean(), host: z.string().min(1), port: z.number().int(), secure: z.boolean(), user: z.string(), from: z.string().min(3) }),
      })
      .parse(req.body);
    try {
      await sendTestEmail(b.smtp, b.to);
      await audit(req.user.id, 'TEST_EMAIL_SENT', 'Setting', null, null, { to: b.to, host: b.smtp.host }, req.ip);
      return { ok: true, message: `Test email sent to ${b.to}. Check the inbox (and spam folder).` };
    } catch (err) {
      return reply.code(400).send({ error: `Could not send: ${(err as Error).message}` });
    }
  });
}

async function certificateInfo() {
  const path = process.env.M365_CERT_PATH?.trim();
  if (!path) return null;
  try {
    const { readFile } = await import('node:fs/promises');
    const { X509Certificate } = await import('node:crypto');
    const pem = await readFile(path, 'utf8');
    const block = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem)?.[0];
    if (!block) return { error: 'No certificate found in the PEM file' };
    const c = new X509Certificate(block);
    const expires = new Date(c.validTo);
    return { subject: c.subject, expires, daysLeft: Math.floor((expires.getTime() - Date.now()) / 86_400_000) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
