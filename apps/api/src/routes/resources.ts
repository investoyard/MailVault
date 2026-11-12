import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkFolder } from '@mailvault/core/node';
import { prisma, type Prisma } from '@mailvault/db';
import { destinationInputSchema, mailboxInputSchema, DOWNLOAD_STATUSES, QUEUES, type SyncJob } from '@mailvault/shared';
import { M365Provider, explainGraphError, graphConfigFromEnv, GraphError } from '@mailvault/m365';
import { requirePermission } from '../auth.js';
import { getQueue } from '../queue.js';

const graphReady = () => Boolean(process.env.M365_TENANT_ID?.trim() && process.env.M365_CLIENT_ID?.trim());

const idParam = z.object({ id: z.string().min(1) });

export async function resourceRoutes(app: FastifyInstance) {
  // ─────────── Mailboxes ───────────
  app.get('/mailboxes', { preHandler: requirePermission('accounts') }, async () => {
    const rows = await prisma.mailbox.findMany({
      orderBy: { email: 'asc' },
      include: { _count: { select: { rules: true, messages: true } }, folders: { select: { displayName: true } } },
    });
    return rows.map(({ encryptedToken: _t, ...m }) => m);
  });

  app.post('/mailboxes', { preHandler: requirePermission('accounts', 'create') }, async (req) => {
    const input = mailboxInputSchema.parse(req.body);
    const mailbox = await prisma.mailbox.create({
      data: {
        ...input,
        monitoringStartAt: input.monitoringStartAt ? new Date(input.monitoringStartAt) : new Date(),
        folders: { create: { providerFolderId: 'inbox', displayName: 'Inbox' } },
      },
    });
    await audit(req.user.id, 'MAILBOX_CREATED', 'Mailbox', mailbox.id, null, input, req.ip);
    return mailbox;
  });

  app.patch('/mailboxes/:id', { preHandler: requirePermission('accounts', 'edit') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const patch = mailboxInputSchema.partial().parse(req.body);
    const before = await prisma.mailbox.findUniqueOrThrow({ where: { id } });
    const data: Prisma.MailboxUpdateInput = {
      ...patch,
      monitoringStartAt: patch.monitoringStartAt ? new Date(patch.monitoringStartAt) : undefined,
    };
    if (patch.enabled === false) data.status = 'DISABLED';
    if (patch.enabled === true && before.status === 'DISABLED') data.status = 'PENDING_SETUP';
    const after = await prisma.mailbox.update({ where: { id }, data });
    await audit(req.user.id, 'MAILBOX_UPDATED', 'Mailbox', id, pick(before, patch), patch, req.ip);
    return after;
  });

  app.post('/mailboxes/:id/test', { preHandler: requirePermission('accounts', 'execute') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const mailbox = await prisma.mailbox.findUniqueOrThrow({ where: { id } });
    let result;
    try {
      result = await new M365Provider(graphConfigFromEnv()).testConnection(mailbox.email);
    } catch (err) {
      result = { ok: false, latencyMs: 0, mailbox: mailbox.email, error: (err as Error).message };
    }
    await prisma.mailbox.update({
      where: { id },
      data: result.ok
        ? { status: mailbox.enabled ? 'CONNECTED' : 'DISABLED', lastError: null }
        : { status: 'DISCONNECTED', lastError: result.error },
    });
    await prisma.processingLog.create({
      data: {
        level: result.ok ? 'info' : 'warn',
        source: 'connection-test',
        message: result.ok ? `Connection OK (${result.latencyMs} ms)` : `Connection failed: ${result.error}`,
        mailboxId: id,
        data: result as never,
      },
    });
    return result;
  });

  app.post('/mailboxes/:id/sync', { preHandler: requirePermission('accounts', 'execute') }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const mb = await prisma.mailbox.findUniqueOrThrow({ where: { id } });
    if (!mb.enabled) return reply.code(400).send({ error: 'Monitoring is paused for this mailbox. Enable it first.' });
    if (!graphReady()) return reply.code(400).send({ error: 'Microsoft 365 is not configured yet (see docs/ENTRA-SETUP.md).' });
    const boss = await getQueue();
    await boss.send(QUEUES.syncMailbox, { mailboxId: id, trigger: 'MANUAL_SYNC' } satisfies SyncJob, { singletonKey: id });
    await audit(req.user.id, 'MAILBOX_SYNC_REQUESTED', 'Mailbox', id, null, null, req.ip);
    return { ok: true, message: `Sync started for ${mb.email}. New emails will appear in a few moments.` };
  });

  app.get('/mailboxes/:id/folders', { preHandler: requirePermission('accounts') }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const mb = await prisma.mailbox.findUniqueOrThrow({ where: { id }, include: { folders: true } });
    const monitored = mb.folders.map((f) => ({ id: f.providerFolderId, displayName: f.displayName, lastSyncAt: f.lastSyncAt }));
    if (!graphReady()) return { available: null, monitored, error: 'Microsoft 365 is not configured yet, so folders cannot be listed.' };
    try {
      const available = await new M365Provider(graphConfigFromEnv()).listFolders(mb.email);
      return { available, monitored, error: null };
    } catch (err) {
      return reply.code(200).send({ available: null, monitored, error: err instanceof GraphError ? explainGraphError(err) : (err as Error).message });
    }
  });

  app.put('/mailboxes/:id/folders', { preHandler: requirePermission('accounts', 'edit') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { folders } = z.object({ folders: z.array(z.object({ id: z.string().min(1), displayName: z.string().min(1) })).min(1) }).parse(req.body);
    const existing = await prisma.mailboxFolder.findMany({ where: { mailboxId: id } });
    const keep = new Set(folders.map((f) => f.id));
    await prisma.$transaction([
      prisma.mailboxFolder.deleteMany({ where: { mailboxId: id, providerFolderId: { notIn: [...keep] } } }),
      ...folders
        .filter((f) => !existing.some((e) => e.providerFolderId === f.id))
        .map((f) => prisma.mailboxFolder.create({ data: { mailboxId: id, providerFolderId: f.id, displayName: f.displayName } })),
    ]);
    await audit(req.user.id, 'MAILBOX_FOLDERS_UPDATED', 'Mailbox', id, existing.map((e) => e.displayName), folders.map((f) => f.displayName), req.ip);
    return { ok: true };
  });

  // ─────────── Destinations ───────────
  app.get('/destinations', { preHandler: requirePermission('destinations') }, async () =>
    prisma.destination.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { rules: true } } } }),
  );

  app.post('/destinations', { preHandler: requirePermission('destinations', 'create') }, async (req) => {
    const input = destinationInputSchema.parse(req.body);
    const check = await checkFolder(input.basePath, input.createIfMissing, input.lowSpaceThresholdMb);
    const dest = await prisma.destination.create({
      data: {
        ...input,
        status: check.status,
        freeSpaceMb: check.freeMb !== null ? BigInt(check.freeMb) : null,
        lastError: check.error,
        lastCheckedAt: new Date(),
      },
    });
    await audit(req.user.id, 'DESTINATION_CREATED', 'Destination', dest.id, null, input, req.ip);
    return dest;
  });

  app.post('/destinations/:id/check', { preHandler: requirePermission('destinations', 'execute') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const d = await prisma.destination.findUniqueOrThrow({ where: { id } });
    const check = await checkFolder(d.basePath, d.createIfMissing, d.lowSpaceThresholdMb);
    return prisma.destination.update({
      where: { id },
      data: {
        status: check.status,
        freeSpaceMb: check.freeMb !== null ? BigInt(check.freeMb) : null,
        lastError: check.error,
        lastCheckedAt: new Date(),
      },
    });
  });

  // ─────────── Rules ───────────
  app.get('/rules', { preHandler: requirePermission('rules') }, async () => {
    const rules = await prisma.rule.findMany({
      orderBy: [{ mailbox: { email: 'asc' } }, { priority: 'asc' }],
      include: {
        mailbox: { select: { email: true } },
        destination: { select: { name: true, basePath: true, status: true } },
        _count: { select: { matches: true } },
      },
    });
    return rules;
  });

  app.patch('/rules/:id/enabled', { preHandler: requirePermission('rules', 'edit') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const rule = await prisma.rule.update({ where: { id }, data: { enabled } });
    await audit(req.user.id, enabled ? 'RULE_ENABLED' : 'RULE_DISABLED', 'Rule', id, null, { enabled }, req.ip);
    return rule;
  });

  // ─────────── Retry / manual download ───────────
  app.post('/history/:id/retry', { preHandler: requirePermission('history', 'execute') }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const d = await prisma.attachmentDownload.findUniqueOrThrow({ where: { id } });
    if (!['FAILED', 'WAITING_DESTINATION', 'RETRYING', 'AWAITING_MANUAL'].includes(d.status)) {
      return reply.code(400).send({ error: 'Only failed, waiting or manual downloads can be retried' });
    }
    await prisma.attachmentDownload.update({
      where: { id },
      data: { status: 'PENDING', attempts: 0, nextAttemptAt: null, errorCode: null, errorMessage: null },
    });
    await (await getQueue()).send(QUEUES.processDownloads, {}, { singletonKey: 'all' });
    await audit(req.user.id, d.status === 'AWAITING_MANUAL' ? 'DOWNLOAD_MANUAL' : 'DOWNLOAD_RETRY', 'AttachmentDownload', id, { status: d.status }, { status: 'PENDING' }, req.ip);
    return { ok: true };
  });

  // ─────────── History ───────────
  const historyQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(10).max(200).default(25),
    status: z.enum(DOWNLOAD_STATUSES).optional(),
    mailboxId: z.string().optional(),
    ruleId: z.string().optional(),
    sender: z.string().trim().optional(),
    subject: z.string().trim().optional(),
    fileName: z.string().trim().optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  });

  app.get('/history', { preHandler: requirePermission('history') }, async (req) => {
    const q = historyQuery.parse(req.query);
    const where: Prisma.AttachmentDownloadWhereInput = {
      status: q.status,
      attachment: q.fileName ? { name: { contains: q.fileName, mode: 'insensitive' } } : undefined,
      match: {
        ruleId: q.ruleId,
        message: {
          mailboxId: q.mailboxId,
          fromEmail: q.sender ? { contains: q.sender, mode: 'insensitive' } : undefined,
          subject: q.subject ? { contains: q.subject, mode: 'insensitive' } : undefined,
          receivedAt: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined,
        },
      },
    };
    const [total, rows] = await Promise.all([
      prisma.attachmentDownload.count({ where }),
      prisma.attachmentDownload.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          attachment: { select: { name: true, sizeBytes: true, contentType: true } },
          match: {
            select: {
              correlationId: true,
              trigger: true,
              rule: { select: { id: true, name: true } },
              message: {
                select: {
                  fromEmail: true,
                  fromName: true,
                  toEmails: true,
                  ccEmails: true,
                  subject: true,
                  receivedAt: true,
                  mailbox: { select: { id: true, email: true } },
                },
              },
            },
          },
        },
      }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, rows };
  });
}

function pick(obj: Record<string, unknown>, keys: object) {
  return Object.fromEntries(Object.keys(keys).map((k) => [k, obj[k]]));
}

export async function audit(
  userId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  before: unknown,
  after: unknown,
  ip?: string,
) {
  await prisma.auditLog.create({
    data: {
      userId,
      action,
      entityType,
      entityId,
      before: (before ?? undefined) as never,
      after: (after ?? undefined) as never,
      ip,
    },
  });
}
