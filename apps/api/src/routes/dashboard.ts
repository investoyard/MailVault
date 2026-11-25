import type { FastifyInstance } from 'fastify';
import { prisma, Prisma } from '@mailvault/db';
import { env } from '../env.js';
import { mailboxScope, requirePermission } from '../auth.js';

const ACTIVE_STATUSES = ['PENDING', 'IN_PROGRESS', 'RETRYING', 'WAITING_DESTINATION'] as const;

// Simulation ("test run") records are stored as SKIPPED with a skipReason starting "Simulation:" (worker evaluate.ts).
// They are not real outcomes, so the dashboard leaves them out; Download History still lists them (tagged "Test run").
const SIM_PREFIX = 'Simulation:';
const notSimulation: Prisma.AttachmentDownloadWhereInput = {
  OR: [{ status: { not: 'SKIPPED' } }, { skipReason: null }, { NOT: { skipReason: { startsWith: SIM_PREFIX } } }],
};
const notSimulationSql = (alias: string) =>
  Prisma.sql`NOT (${Prisma.raw(alias)}.status = 'SKIPPED' AND coalesce(${Prisma.raw(alias)}."skipReason", '') LIKE ${SIM_PREFIX + '%'})`;

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/summary', { preHandler: requirePermission('dashboard') }, async (req) => {
    const query = req.query as { days?: string; mailboxId?: string };
    const days = Math.min(90, Math.max(7, Number(query.days ?? 14)));
    const tz = env.timeZone;
    // Respect the user's mailbox access, optionally narrowed to one mailbox.
    const ids = mailboxScope(req, query.mailboxId || null);
    const mbIn = ids ? { in: ids } : undefined;
    const sqlMb = (col: Prisma.Sql) => (ids === undefined ? Prisma.empty : ids.length ? Prisma.sql`AND ${col} IN (${Prisma.join(ids)})` : Prisma.sql`AND false`);

    const [today] = await prisma.$queryRaw<{ start: Date }[]>`
      SELECT (date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AS start`;
    const start = today?.start ?? new Date(new Date().setHours(0, 0, 0, 0));

    const dlWhere: Prisma.AttachmentDownloadWhereInput = ids ? { AND: [notSimulation, { match: { message: { mailboxId: mbIn } } }] } : notSimulation;
    const [emailsScanned, emailsMatched, byStatus, todayByStatus, unevaluated, todayScanned] = await Promise.all([
      prisma.message.count({ where: { evaluatedAt: { not: null }, mailboxId: mbIn } }),
      prisma.message.count({ where: { matches: { some: {} }, mailboxId: mbIn } }),
      prisma.attachmentDownload.groupBy({ by: ['status'], where: dlWhere, _count: { _all: true } }),
      prisma.attachmentDownload.groupBy({ by: ['status'], where: { ...dlWhere, updatedAt: { gte: start } }, _count: { _all: true } }),
      prisma.message.count({ where: { evaluatedAt: null, mailboxId: mbIn } }),
      prisma.message.count({ where: { firstSeenAt: { gte: start }, mailboxId: mbIn } }),
    ]);

    const count = (rows: typeof byStatus, ...statuses: string[]) =>
      rows.filter((r) => statuses.includes(r.status)).reduce((s, r) => s + r._count._all, 0);

    const trend = await prisma.$queryRaw<{ day: string; success: number; failed: number; skipped: number }[]>`
      WITH d AS (
        SELECT to_char(gs, 'YYYY-MM-DD') AS day
        FROM generate_series((now() AT TIME ZONE ${tz})::date - (${days}::int - 1), (now() AT TIME ZONE ${tz})::date, '1 day') gs
      ),
      a AS (
        SELECT dl.status, to_char((dl."updatedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day
        FROM "AttachmentDownload" dl
        JOIN "MessageRuleMatch" m ON m.id = dl."matchId"
        JOIN "Message" msg ON msg.id = m."messageId"
        WHERE dl."updatedAt" >= (now() AT TIME ZONE 'UTC') - make_interval(days => (${days}::int + 1)) AND ${notSimulationSql('dl')} ${sqlMb(Prisma.sql`msg."mailboxId"`)}
      )
      SELECT d.day,
        COUNT(a.status) FILTER (WHERE a.status = 'SUCCESS')::int AS success,
        COUNT(a.status) FILTER (WHERE a.status = 'FAILED')::int  AS failed,
        COUNT(a.status) FILTER (WHERE a.status = 'SKIPPED')::int AS skipped
      FROM d LEFT JOIN a ON a.day = d.day
      GROUP BY d.day ORDER BY d.day`;

    const ruleStats = await prisma.$queryRaw<{ ruleId: string; ruleName: string; mailbox: string; success: number; failed: number; skipped: number }[]>`
      SELECT r.id AS "ruleId", r.name AS "ruleName", mb.email AS mailbox,
        COUNT(*) FILTER (WHERE a.status = 'SUCCESS')::int AS success,
        COUNT(*) FILTER (WHERE a.status = 'FAILED')::int  AS failed,
        COUNT(*) FILTER (WHERE a.status = 'SKIPPED')::int AS skipped
      FROM "Rule" r
      JOIN "Mailbox" mb ON mb.id = r."mailboxId"
      LEFT JOIN "MessageRuleMatch" m ON m."ruleId" = r.id
      LEFT JOIN "AttachmentDownload" a ON a."matchId" = m.id AND ${notSimulationSql('a')}
      WHERE true ${sqlMb(Prisma.sql`r."mailboxId"`)}
      GROUP BY r.id, r.name, mb.email
      ORDER BY success DESC, r.name
      LIMIT 8`;

    const recent = await prisma.attachmentDownload.findMany({
      where: dlWhere,
      orderBy: { updatedAt: 'desc' },
      take: 8,
      select: {
        id: true,
        status: true,
        finalFileName: true,
        errorMessage: true,
        skipReason: true,
        updatedAt: true,
        attachment: { select: { name: true, sizeBytes: true } },
        match: { select: { rule: { select: { name: true } }, message: { select: { fromEmail: true, subject: true, mailbox: { select: { email: true } } } } } },
      },
    });

    const [mailboxes, destinations, heartbeat] = await Promise.all([
      prisma.mailbox.findMany({
        where: { id: mbIn },
        orderBy: { email: 'asc' },
        select: { id: true, email: true, displayName: true, status: true, enabled: true, lastSyncAt: true, lastError: true },
      }),
      prisma.destination.findMany({
        where: ids ? { rules: { some: { mailboxId: mbIn } } } : {},
        orderBy: { name: 'asc' },
        select: { id: true, name: true, basePath: true, status: true, freeSpaceMb: true, lastCheckedAt: true },
      }),
      prisma.serviceHeartbeat.findFirst({ where: { service: 'worker' }, orderBy: { lastBeatAt: 'desc' } }),
    ]);

    return {
      kpis: {
        emailsScanned,
        emailsMatched,
        downloadsTotal: count(byStatus, 'SUCCESS', 'FAILED', 'SKIPPED'),
        success: count(byStatus, 'SUCCESS'),
        failed: count(byStatus, 'FAILED'),
        skipped: count(byStatus, 'SKIPPED'),
        pending: count(byStatus, ...ACTIVE_STATUSES, 'AWAITING_MANUAL') + unevaluated,
        today: {
          emailsScanned: todayScanned,
          success: count(todayByStatus, 'SUCCESS'),
          failed: count(todayByStatus, 'FAILED'),
          skipped: count(todayByStatus, 'SKIPPED'),
        },
      },
      trend,
      ruleStats,
      recent: recent.map((r) => ({
        id: r.id,
        status: r.status,
        fileName: r.finalFileName ?? r.attachment.name,
        sizeBytes: r.attachment.sizeBytes,
        ruleName: r.match.rule.name,
        sender: r.match.message.fromEmail,
        subject: r.match.message.subject,
        mailbox: r.match.message.mailbox.email,
        note: r.errorMessage ?? r.skipReason,
        at: r.updatedAt,
      })),
      mailboxes,
      destinations,
      worker: heartbeat
        ? {
            online: Date.now() - heartbeat.lastBeatAt.getTime() < 3 * 60_000,
            lastBeatAt: heartbeat.lastBeatAt,
            hostname: heartbeat.hostname,
            version: heartbeat.version,
            memoryMb: heartbeat.memoryMb,
            startedAt: heartbeat.startedAt,
          }
        : null,
      timeZone: tz,
    };
  });
}
