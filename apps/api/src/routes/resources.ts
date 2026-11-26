import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertAllowed, normalizeFolderPath } from '@mailvault/core/node';
import { browseRoots, prisma, type Prisma } from '@mailvault/db';
import { destinationInputSchema, mailboxInputSchema, DOWNLOAD_STATUSES, QUEUES, type SyncJob } from '@mailvault/shared';
import { M365Provider, explainGraphError, graphConfigFromEnv, GraphError } from '@mailvault/m365';
import { assertMailbox, invalidateAccess, mailboxScope, requireAdminPermission, requirePermission } from '../auth.js';
import { getQueue } from '../queue.js';
import { folderOp } from '../folder-ops.js';

const graphReady = () => Boolean(process.env.M365_TENANT_ID?.trim() && process.env.M365_CLIENT_ID?.trim());

const idParam = z.object({ id: z.string().min(1) });

export async function resourceRoutes(app: FastifyInstance) {
  // ─────────── Mailboxes ───────────
  app.get('/mailboxes', { preHandler: requirePermission('accounts') }, async (req) => {
    const scope = mailboxScope(req);
    const rows = await prisma.mailbox.findMany({
      where: scope ? { id: { in: scope } } : {},
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
    // Non-super-admins automatically get access to the mailbox they add.
    if (req.access.mailboxIds !== null) {
      await prisma.userMailboxAccess.create({ data: { userId: req.user.id, mailboxId: mailbox.id } });
      invalidateAccess(req.user.id);
    }
    await audit(req.user.id, 'MAILBOX_CREATED', 'Mailbox', mailbox.id, null, input, req.ip);
    return mailbox;
  });

  app.patch('/mailboxes/:id', { preHandler: requirePermission('accounts', 'edit') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const patch = mailboxInputSchema.partial().parse(req.body);
    assertMailbox(req, id);
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
    assertMailbox(req, id);
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
    assertMailbox(req, id);
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
    assertMailbox(req, id);
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
    assertMailbox(req, id);
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

  // Folder checks run in the worker (the account that writes the files); see ../folder-ops.ts.
  const testFolder = async (path: string, createIfMissing: boolean, lowSpaceThresholdMb: number) => {
    const r = await folderOp({ op: 'test', path, createIfMissing, lowSpaceThresholdMb });
    const check = r.ok && r.check ? r.check : { status: 'UNAVAILABLE' as const, freeMb: null, error: r.ok ? 'No result' : r.error };
    return {
      status: check.status,
      freeSpaceMb: check.freeMb !== null ? BigInt(check.freeMb) : null,
      lastError: check.error,
      lastCheckedAt: new Date(),
    };
  };

  /** Normalizes the path and refuses system folders / folders outside the allowed roots (400). */
  const allowedPath = async (path: string) => {
    try {
      const p = normalizeFolderPath(path);
      assertAllowed(p, (await browseRoots()).map(normalizeFolderPath));
      return p;
    } catch (err) {
      throw Object.assign(new Error((err as Error).message), { statusCode: 400 });
    }
  };

  app.post('/destinations', { preHandler: requirePermission('destinations', 'create') }, async (req) => {
    const input = destinationInputSchema.parse(req.body);
    input.basePath = await allowedPath(input.basePath);
    const health = await testFolder(input.basePath, input.createIfMissing, input.lowSpaceThresholdMb);
    const dest = await prisma.destination.create({ data: { ...input, ...health } });
    await audit(req.user.id, 'DESTINATION_CREATED', 'Destination', dest.id, null, input, req.ip);
    return dest;
  });

  // Edit (Admin / Super Admin only). A changed path or setting is checked again right away.
  app.patch('/destinations/:id', { preHandler: requireAdminPermission('destinations', 'edit') }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const patch = destinationInputSchema.partial().parse(req.body);
    const before = await prisma.destination.findUniqueOrThrow({ where: { id } });
    if (patch.basePath !== undefined) patch.basePath = await allowedPath(patch.basePath);
    if (patch.name !== undefined && patch.name !== before.name) {
      const taken = await prisma.destination.findFirst({ where: { name: patch.name, id: { not: id } }, select: { id: true } });
      if (taken) return reply.code(409).send({ error: `Another destination folder is already called "${patch.name}"` });
    }
    const merged = { ...before, ...patch };
    const recheck =
      merged.basePath !== before.basePath ||
      merged.createIfMissing !== before.createIfMissing ||
      merged.lowSpaceThresholdMb !== before.lowSpaceThresholdMb;
    const health = recheck ? await testFolder(merged.basePath, merged.createIfMissing, merged.lowSpaceThresholdMb) : {};
    const after = await prisma.destination.update({ where: { id }, data: { ...patch, ...health } });
    await audit(req.user.id, 'DESTINATION_UPDATED', 'Destination', id, pick(before, patch), patch, req.ip);
    return after;
  });

  // Permanent delete (Admin / Super Admin only). Refused while any rule (enabled or disabled) still uses the folder;
  // files already saved in the folder are not touched.
  app.delete('/destinations/:id', { preHandler: requireAdminPermission('destinations', 'delete') }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const dest = await prisma.destination.findUniqueOrThrow({ where: { id } });
    const rules = await prisma.rule.findMany({ where: { destinationId: id }, select: { name: true }, orderBy: { name: 'asc' } });
    if (rules.length) {
      const names = rules.slice(0, 5).map((r) => `"${r.name}"`).join(', ') + (rules.length > 5 ? ` and ${rules.length - 5} more` : '');
      return reply.code(409).send({
        error: `This folder is still used by ${rules.length} rule${rules.length === 1 ? '' : 's'} (${names}). Move those rules to another folder first, including disabled rules.`,
      });
    }
    await prisma.$transaction([
      prisma.destination.delete({ where: { id } }),
      // Open "folder unavailable / low space" alerts for this folder no longer apply.
      prisma.notification.updateMany({
        where: { alertKey: { in: [`DESTINATION:${id}`, `DESTINATION_SPACE:${id}`] }, resolvedAt: null },
        data: { resolvedAt: new Date() },
      }),
    ]);
    await audit(req.user.id, 'DESTINATION_DELETED', 'Destination', id, { name: dest.name, basePath: dest.basePath }, null, req.ip);
    return { ok: true };
  });

  app.post('/destinations/:id/check',{ preHandler: requirePermission('destinations', 'execute') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const d = await prisma.destination.findUniqueOrThrow({ where: { id } });
    return prisma.destination.update({ where: { id }, data: await testFolder(d.basePath, d.createIfMissing, d.lowSpaceThresholdMb) });
  });

  // ─────────── Destination picker (folder names only, never files) ───────────
  app.post('/destinations/browse', { preHandler: requirePermission('destinations', 'create') }, async (req) => {
    const { path } = z.object({ path: z.string().max(400).nullish() }).parse(req.body ?? {});
    return folderOp({ op: 'browse', path: path ?? null });
  });

  app.post('/destinations/test', { preHandler: requirePermission('destinations', 'create') }, async (req) => {
    const b = z
      .object({
        basePath: z.string().trim().min(2).max(400),
        createIfMissing: z.boolean().default(true),
        lowSpaceThresholdMb: z.number().int().positive().default(1024),
      })
      .parse(req.body);
    return folderOp({ op: 'test', path: b.basePath, createIfMissing: b.createIfMissing, lowSpaceThresholdMb: b.lowSpaceThresholdMb });
  });

  app.post('/destinations/mkdir', { preHandler: requirePermission('destinations', 'create') }, async (req) => {
    const b = z.object({ parent: z.string().trim().min(2).max(400), name: z.string().trim().min(1).max(120) }).parse(req.body);
    const r = await folderOp({ op: 'mkdir', parent: b.parent, name: b.name });
    if (r.ok) await audit(req.user.id, 'FOLDER_CREATED', 'Destination', null, null, { path: r.created, account: r.account, via: r.via }, req.ip);
    return r;
  });

  // ─────────── Rules ───────────
  app.get('/rules', { preHandler: requirePermission('rules') }, async (req) => {
    const scope = mailboxScope(req);
    const rules = await prisma.rule.findMany({
      where: scope ? { mailboxId: { in: scope } } : {},
      // Same order the worker evaluates rules in (priority, then oldest first), so the list's # is the run order.
      orderBy: [{ mailbox: { email: 'asc' } }, { priority: 'asc' }, { createdAt: 'asc' }],
      omit: { filePasswords: true },
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
    assertMailbox(req, (await prisma.rule.findUniqueOrThrow({ where: { id } })).mailboxId);
    const rule = await prisma.rule.update({ where: { id }, data: { enabled } });
    await audit(req.user.id, enabled ? 'RULE_ENABLED' : 'RULE_DISABLED', 'Rule', id, null, { enabled }, req.ip);
    return rule;
  });

  const PROTECTION_LABEL: Record<string, string> = { NONE: 'Not protected', UNLOCKED: 'Password removed', RESTRICTIONS_REMOVED: 'Restrictions removed', STILL_LOCKED: 'Still password-protected' };

  // ─────────── Retry / manual download ───────────
  app.post('/history/:id/retry', { preHandler: requirePermission('history', 'execute') }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const d = await prisma.attachmentDownload.findUniqueOrThrow({ where: { id }, include: { match: { select: { message: { select: { mailboxId: true } } } } } });
    assertMailbox(req, d.match.message.mailboxId);
    const lockedCopy = d.status === 'SUCCESS' && d.protection === 'STILL_LOCKED';
    if (!lockedCopy && !['FAILED', 'WAITING_DESTINATION', 'RETRYING', 'AWAITING_MANUAL'].includes(d.status)) {
      return reply.code(400).send({ error: 'Only failed, waiting, manual or still password-protected downloads can be retried' });
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

  const historyWhere = (q: z.infer<typeof historyQuery>, scope?: string[]): Prisma.AttachmentDownloadWhereInput => ({
    status: q.status,
    attachment: q.fileName ? { name: { contains: q.fileName, mode: 'insensitive' } } : undefined,
    match: {
      ruleId: q.ruleId,
      message: {
        mailboxId: scope ? { in: scope } : undefined,
        fromEmail: q.sender ? { contains: q.sender, mode: 'insensitive' } : undefined,
        subject: q.subject ? { contains: q.subject, mode: 'insensitive' } : undefined,
        receivedAt: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined,
      },
    },
  });

  app.post('/history/retry-bulk', { preHandler: requirePermission('history', 'execute') }, async (req) => {
    const { ids } = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) }).parse(req.body);
    const { count } = await prisma.attachmentDownload.updateMany({
      where: { id: { in: ids }, OR: [{ status: { in: ['FAILED', 'WAITING_DESTINATION', 'RETRYING'] } }, { status: 'SUCCESS', protection: 'STILL_LOCKED' }], ...(mailboxScope(req) ? { match: { message: { mailboxId: { in: mailboxScope(req) } } } } : {}) },
      data: { status: 'PENDING', attempts: 0, nextAttemptAt: null, errorCode: null, errorMessage: null },
    });
    if (count) await (await getQueue()).send(QUEUES.processDownloads, {}, { singletonKey: 'all' });
    await audit(req.user.id, 'DOWNLOAD_RETRY_BULK', 'AttachmentDownload', null, null, { requested: ids.length, retried: count }, req.ip);
    return { ok: true, retried: count, skipped: ids.length - count };
  });

  // Excel export of the current filter (streamed, so large exports don't use much memory).
  app.get('/history/export', { preHandler: requirePermission('history') }, async (req, reply) => {
    const q = historyQuery.parse(req.query);
    const where = historyWhere(q, mailboxScope(req, q.mailboxId));
    const ExcelJS = (await import('exceljs')).default;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    reply.raw.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="MailVault-history-${stamp}.xlsx"`,
    });
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: reply.raw, useStyles: true });
    const ws = wb.addWorksheet('Download history', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Email account', key: 'mailbox', width: 28 },
      { header: 'Sender', key: 'sender', width: 30 },
      { header: 'Recipients', key: 'to', width: 30 },
      { header: 'Subject', key: 'subject', width: 45 },
      { header: 'Received', key: 'received', width: 19, style: { numFmt: 'dd-mmm-yyyy hh:mm' } },
      { header: 'Attachment', key: 'file', width: 34 },
      { header: 'Size (KB)', key: 'size', width: 11 },
      { header: 'Rule', key: 'rule', width: 24 },
      { header: 'Trigger', key: 'trigger', width: 12 },
      { header: 'Destination path', key: 'path', width: 60 },
      { header: 'Downloaded', key: 'downloaded', width: 19, style: { numFmt: 'dd-mmm-yyyy hh:mm' } },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Reason / error', key: 'note', width: 50 },
      { header: 'Password', key: 'protection', width: 22 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3C2E7E' } };
    ws.getRow(1).commit();

    // Excel has no time zones: write wall-clock times in the business time zone.
    const tz = process.env.BUSINESS_TIMEZONE ?? 'Asia/Kolkata';
    const local = (d: Date | null) => {
      if (!d) return null;
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
      return new Date(Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!));
    };

    let cursor: string | undefined;
    let written = 0;
    for (;;) {
      const batch = await prisma.attachmentDownload.findMany({
        where,
        orderBy: { id: 'asc' },
        take: 1000,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        include: { attachment: true, match: { include: { rule: { select: { name: true } }, message: { include: { mailbox: { select: { email: true } } } } } } },
      });
      for (const r of batch) {
        ws.addRow({
          mailbox: r.match.message.mailbox.email,
          sender: r.match.message.fromEmail,
          to: r.match.message.toEmails.join('; '),
          subject: r.match.message.subject,
          received: local(r.match.message.receivedAt),
          file: r.finalFileName ?? r.attachment.name,
          size: Math.round(r.attachment.sizeBytes / 102.4) / 10,
          rule: r.match.rule.name,
          trigger: r.match.trigger,
          path: r.destinationPath ?? '',
          downloaded: local(r.downloadedAt),
          status: r.status,
          note: r.errorMessage ?? r.skipReason ?? '',
          protection: PROTECTION_LABEL[r.protection ?? ''] ?? '',
        }).commit();
      }
      written += batch.length;
      if (batch.length < 1000 || written >= 200_000) break;
      cursor = batch.at(-1)!.id;
    }
    ws.autoFilter = { from: 'A1', to: 'N1' };
    await wb.commit();
    await audit(req.user.id, 'HISTORY_EXPORTED', 'AttachmentDownload', null, null, { rows: written, filters: q }, req.ip);
    return reply;
  });

  // Email details: stored metadata plus the live body text from the mailbox (bodies are never stored).
  app.get('/history/:id/email', { preHandler: requirePermission('history') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const d = await prisma.attachmentDownload.findUniqueOrThrow({
      where: { id },
      include: { match: { include: { message: { include: { mailbox: true, attachments: true, matches: { include: { rule: { select: { name: true } } } } } } } } },
    });
    const m = d.match.message;
    assertMailbox(req, m.mailboxId);
    let body: string | null = null;
    let bodyError: string | null = null;
    if (graphReady()) {
      try {
        body = (await new M365Provider(graphConfigFromEnv()).getBodyText({ mailbox: m.mailbox.email, messageId: m.providerMessageId })).slice(0, 20_000);
      } catch (err) {
        bodyError = err instanceof GraphError ? explainGraphError(err) : (err as Error).message;
      }
    } else {
      bodyError = 'Microsoft 365 is not configured, so the email body cannot be shown.';
    }
    return {
      subject: m.subject,
      from: m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail,
      to: m.toEmails,
      cc: m.ccEmails,
      receivedAt: m.receivedAt,
      mailbox: m.mailbox.email,
      internetMessageId: m.internetMessageId,
      attachments: m.attachments.map((a) => ({ name: a.name, sizeBytes: a.sizeBytes, isInline: a.isInline, kind: a.kind })),
      rulesApplied: m.matches.map((x) => ({ rule: x.rule.name, trigger: x.trigger, runNumber: x.runNumber, at: x.matchedAt })),
      body,
      bodyError,
    };
  });

  // Save a copy of a downloaded file to the user's computer (only files MailVault wrote, inside their destination folder).
  app.get('/history/:id/file', { preHandler: requirePermission('history', 'execute') }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const d = await prisma.attachmentDownload.findUniqueOrThrow({ where: { id }, include: { match: { include: { rule: { include: { destination: true } } } } } });
    assertMailbox(req, d.match.rule.mailboxId);
    if (d.status !== 'SUCCESS' || !d.destinationPath) return reply.code(400).send({ error: 'This file was not saved by MailVault' });
    const { resolve: resolvePath, basename } = await import('node:path');
    const { createReadStream } = await import('node:fs');
    const { stat } = await import('node:fs/promises');
    const base = resolvePath(d.match.rule.destination.basePath).toLowerCase() + '\\';
    const full = resolvePath(d.destinationPath);
    const inCurrentFolder = full.toLowerCase().startsWith(base);
    try {
      await stat(full);
    } catch {
      return reply.code(404).send({
        error: inCurrentFolder
          ? 'The file is no longer in the destination folder (moved or deleted)'
          : `The file was saved to ${full} (the rule's earlier folder) and is no longer there (moved or deleted)`,
      });
    }
    // Saved before the rule moved to another folder: only hand it out if it is still exactly the file MailVault wrote.
    if (!inCurrentFolder) {
      const { sha256File } = await import('@mailvault/core/node');
      if (!d.sha256 || (await sha256File(full)) !== d.sha256) {
        return reply.code(403).send({ error: `The file at ${full} has been changed since MailVault saved it, so it cannot be downloaded from here` });
      }
    }
    await audit(req.user.id, 'FILE_DOWNLOADED_BY_USER', 'AttachmentDownload', id, null, { path: full }, req.ip);
    const name = basename(full);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${name.replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.send(createReadStream(full));
  });

  app.get('/history', { preHandler: requirePermission('history') }, async (req) => {
    const q = historyQuery.parse(req.query);
    const where = historyWhere(q, mailboxScope(req, q.mailboxId));
    const [total, rows] = await Promise.all([
      prisma.attachmentDownload.count({ where }),
      prisma.attachmentDownload.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          attachment: { select: { name: true, sizeBytes: true, contentType: true, kind: true } },
          extracted: { orderBy: { innerPath: "asc" }, select: { id: true, innerPath: true, fileName: true, status: true, reason: true, destinationPath: true, bytes: true, protection: true } },
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
