import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, type Prisma } from '@mailvault/db';
import { mailboxScope, requirePermission } from '../auth.js';

/** A run with no finish time this long after starting was cut off (worker stopped mid-sync). */
const STALE_MS = 15 * 60_000;

/** Monitoring → Sync History: every mailbox check, automatic or "Sync now". */
export async function syncRunRoutes(app: FastifyInstance) {
  const query = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(10).max(200).default(50),
    mailboxId: z.string().optional(),
    trigger: z.enum(['AUTO', 'MANUAL_SYNC']).optional(),
    status: z.enum(['ok', 'failed', 'running', 'new-mail']).optional(),
  });

  app.get('/sync-runs', { preHandler: requirePermission('syncHistory') }, async (req) => {
    const q = query.parse(req.query);
    const scope = mailboxScope(req);
    const mailboxFilter: Prisma.SyncRunWhereInput =
      q.mailboxId ? { mailboxId: scope && !scope.includes(q.mailboxId) ? '__none__' : q.mailboxId } : scope ? { mailboxId: { in: scope } } : {};
    const statusFilter: Prisma.SyncRunWhereInput =
      q.status === 'failed'
        ? { error: { not: null } }
        : q.status === 'running'
          ? { finishedAt: null }
          : q.status === 'ok'
            ? { finishedAt: { not: null }, error: null }
            : q.status === 'new-mail'
              ? { newMessages: { gt: 0 } }
              : {};
    const where: Prisma.SyncRunWhereInput = { ...mailboxFilter, ...statusFilter, ...(q.trigger ? { trigger: q.trigger } : {}) };

    const since = new Date(Date.now() - 24 * 3600_000);
    const day: Prisma.SyncRunWhereInput = { ...mailboxFilter, startedAt: { gte: since } };
    const [total, rows, runs24h, failed24h, new24h, lastOk] = await Promise.all([
      prisma.syncRun.count({ where }),
      prisma.syncRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { mailbox: { select: { email: true } } },
      }),
      prisma.syncRun.count({ where: day }),
      prisma.syncRun.count({ where: { ...day, error: { not: null } } }),
      prisma.syncRun.aggregate({ where: day, _sum: { newMessages: true, messagesMatched: true } }),
      prisma.syncRun.findFirst({ where: { ...mailboxFilter, finishedAt: { not: null }, error: null }, orderBy: { startedAt: 'desc' }, select: { finishedAt: true } }),
    ]);

    const now = Date.now();
    return {
      total,
      summary: {
        runs24h,
        failed24h,
        newMessages24h: new24h._sum.newMessages ?? 0,
        matched24h: new24h._sum.messagesMatched ?? 0,
        lastSuccessAt: lastOk?.finishedAt ?? null,
      },
      rows: rows.map((r) => ({
        id: r.id,
        mailboxId: r.mailboxId,
        mailbox: r.mailbox.email,
        trigger: r.trigger,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        durationMs: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
        scanned: r.messagesScanned,
        newMessages: r.newMessages,
        matched: r.messagesMatched,
        error: r.error,
        correlationId: r.correlationId,
        status: r.error ? 'FAILED' : r.finishedAt ? 'OK' : now - r.startedAt.getTime() > STALE_MS ? 'STOPPED' : 'RUNNING',
      })),
    };
  });
}
