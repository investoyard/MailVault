// Rule Testing (live mailbox search + per-rule explanation) and historical jobs.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { evaluateConditions, filterAttachments, type AttachmentInfo, type MailEnvelope } from '@mailvault/core';
import { prisma } from '@mailvault/db';
import { GraphError, M365Provider, explainGraphError, graphConfigFromEnv } from '@mailvault/m365';
import {
  DEFAULT_BLOCKED_EXTENSIONS,
  QUEUES,
  attachmentFilterSchema,
  ruleConditionsSchema,
  ruleInputSchema,
  type HistoricalJobMsg,
  type ManualDownloadJob,
} from '@mailvault/shared';
import { requirePermission } from '../auth.js';
import { getQueue } from '../queue.js';
import { audit } from './resources.js';

const graphReady = () => Boolean(process.env.M365_TENANT_ID?.trim() && process.env.M365_CLIENT_ID?.trim());

async function attachmentPolicy() {
  const rows = await prisma.setting.findMany({ where: { key: { in: ['attachments.blockedExtensions', 'attachments.maxSizeMb', 'attachments.includeInline'] } } });
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, unknown>;
  return {
    blockedExtensions: Array.isArray(s['attachments.blockedExtensions']) ? (s['attachments.blockedExtensions'] as string[]) : DEFAULT_BLOCKED_EXTENSIONS,
    maxSizeMb: typeof s['attachments.maxSizeMb'] === 'number' ? (s['attachments.maxSizeMb'] as number) : 150,
    includeInline: s['attachments.includeInline'] === true,
  };
}

const searchSchema = z.object({
  mailboxId: z.string().min(1),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  sender: z.string().trim().toLowerCase().optional(),
  subject: z.string().trim().toLowerCase().optional(),
  limit: z.number().int().min(1).max(50).default(25),
  draftRule: ruleInputSchema.optional(),
});

export async function testingRoutes(app: FastifyInstance) {
  app.post('/rule-testing/search', { preHandler: requirePermission('ruleTesting', 'execute') }, async (req, reply) => {
    const q = searchSchema.parse(req.body);
    if (!graphReady()) return reply.code(400).send({ error: 'Microsoft 365 is not configured yet (see docs/ENTRA-SETUP.md), so live emails cannot be searched.' });

    const mb = await prisma.mailbox.findUniqueOrThrow({ where: { id: q.mailboxId }, include: { folders: true } });
    const saved = await prisma.rule.findMany({ where: { mailboxId: mb.id }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] });
    const rules = [
      ...(q.draftRule
        ? [{ id: 'draft', name: `${q.draftRule.name || 'Draft rule'} (unsaved)`, enabled: true, priority: q.draftRule.priority, conditions: q.draftRule.conditions, attachments: q.draftRule.attachments }]
        : []),
      ...saved.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, priority: r.priority, conditions: r.conditions, attachments: r.attachments })),
    ];
    const policy = await attachmentPolicy();
    const provider = new M365Provider(graphConfigFromEnv());
    const words = q.subject?.split(/\s+/).filter(Boolean) ?? [];

    // 1. Collect emails (newest first) from the monitored folders, filtered by sender/subject.
    const found: MailEnvelope[] = [];
    let scanned = 0;
    try {
      for (const folder of mb.folders) {
        let cursor: string | null = null;
        let pages = 0;
        do {
          const page = await provider.search({
            mailbox: mb.email,
            folderId: folder.providerFolderId,
            receivedFrom: new Date(q.from),
            receivedTo: new Date(q.to),
            pageSize: 50,
            pageCursor: cursor,
          });
          scanned += page.messages.length;
          for (const m of page.messages) {
            if (q.sender && !m.from.email.includes(q.sender)) continue;
            if (words.length && !words.every((w) => m.subject.toLowerCase().includes(w))) continue;
            found.push(m);
          }
          cursor = page.nextCursor;
        } while (cursor && found.length < q.limit && ++pages < 10);
        if (found.length >= q.limit) break;
      }
    } catch (err) {
      return reply.code(502).send({ error: err instanceof GraphError ? explainGraphError(err) : (err as Error).message });
    }
    found.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
    const emails = found.slice(0, q.limit);

    // 2. Evaluate every rule for every email, with attachments and "already processed" info.
    const known = await prisma.message.findMany({
      where: { mailboxId: mb.id, providerMessageId: { in: emails.map((e) => e.providerMessageId) } },
      include: { matches: { select: { ruleId: true, runNumber: true, matchedAt: true, trigger: true } } },
    });
    const knownBy = new Map(known.map((k) => [k.providerMessageId, k]));

    const results = [];
    for (const e of emails) {
      const ref = { mailbox: mb.email, messageId: e.providerMessageId };
      const attachments: AttachmentInfo[] = e.hasAttachments ? await provider.listAttachments(ref) : [];
      let body: string | undefined;
      const facts = { from: e.from.email, to: e.to.map((a) => a.email), cc: e.cc.map((a) => a.email), subject: e.subject, receivedAt: e.receivedAt };
      const ruleResults = [];
      for (const r of rules) {
        const cond = ruleConditionsSchema.parse(r.conditions);
        let ev = evaluateConditions(cond, facts);
        if (ev.needsBody) {
          body ??= await provider.getBodyText(ref);
          ev = evaluateConditions(cond, facts, body);
        }
        const decisions = filterAttachments(attachmentFilterSchema.parse(r.attachments), attachments, policy).map((d) => ({
          attachmentId: d.attachment.id,
          include: d.include,
          reason: d.reason ?? null,
          saveName: d.saveName,
        }));
        const runs = knownBy.get(e.providerMessageId)?.matches.filter((m) => m.ruleId === r.id) ?? [];
        ruleResults.push({
          ruleId: r.id,
          name: r.name,
          enabled: r.enabled,
          priority: r.priority,
          matched: ev.matched,
          checks: ev.checks,
          decisions,
          processed: runs.length ? { runs: runs.length, lastAt: runs.map((x) => x.matchedAt).sort().at(-1) } : null,
        });
      }
      results.push({
        providerMessageId: e.providerMessageId,
        from: e.from,
        to: e.to,
        cc: e.cc,
        subject: e.subject,
        receivedAt: e.receivedAt,
        attachments,
        rules: ruleResults,
      });
    }
    await audit(req.user.id, 'RULE_TEST_SEARCH', 'Mailbox', mb.id, null, { from: q.from, to: q.to, sender: q.sender, subject: q.subject, results: results.length }, req.ip);
    return { scanned, emails: results };
  });

  app.post('/rule-testing/download', { preHandler: requirePermission('ruleTesting', 'execute') }, async (req, reply) => {
    const body = z
      .object({ mailboxId: z.string().min(1), providerMessageId: z.string().min(1), ruleId: z.string().min(1), attachmentIds: z.array(z.string().min(1)).min(1) })
      .parse(req.body);
    if (!graphReady()) return reply.code(400).send({ error: 'Microsoft 365 is not configured yet.' });
    const rule = await prisma.rule.findUniqueOrThrow({ where: { id: body.ruleId } });
    if (rule.mailboxId !== body.mailboxId) return reply.code(400).send({ error: 'The rule belongs to a different mailbox' });
    await (await getQueue()).send(QUEUES.manualDownload, { ...body, userId: req.user.id } satisfies ManualDownloadJob);
    await audit(req.user.id, 'MANUAL_DOWNLOAD_REQUESTED', 'Rule', rule.id, null, body, req.ip);
    return { ok: true, message: `${body.attachmentIds.length} file(s) queued using "${rule.name}". Watch Download History for the result.` };
  });

  // ─────────── Historical jobs ───────────
  app.get('/historical-jobs', { preHandler: requirePermission('ruleTesting') }, async () => {
    const jobs = await prisma.historicalJob.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { mailbox: { select: { email: true } } } });
    const ruleNames = new Map((await prisma.rule.findMany({ where: { id: { in: jobs.flatMap((j) => j.ruleIds) } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]));
    const users = new Map((await prisma.user.findMany({ select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
    return jobs.map((j) => ({
      ...j,
      checkpoint: undefined,
      ruleNames: j.ruleIds.length ? j.ruleIds.map((id) => ruleNames.get(id) ?? '(deleted rule)') : ['All enabled rules'],
      createdBy: j.createdById ? (users.get(j.createdById) ?? null) : null,
    }));
  });

  app.post('/historical-jobs', { preHandler: requirePermission('ruleTesting', 'execute') }, async (req, reply) => {
    const b = z
      .object({
        mailboxId: z.string().min(1),
        ruleIds: z.array(z.string()).default([]),
        dateFrom: z.iso.datetime(),
        dateTo: z.iso.datetime(),
        simulate: z.boolean().default(true),
        includeProcessed: z.boolean().default(false),
      })
      .refine((v) => new Date(v.dateFrom) < new Date(v.dateTo), 'The start date must be before the end date')
      .parse(req.body);
    if (!graphReady()) return reply.code(400).send({ error: 'Microsoft 365 is not configured yet.' });
    const running = await prisma.historicalJob.count({ where: { mailboxId: b.mailboxId, status: { in: ['QUEUED', 'RUNNING'] } } });
    if (running) return reply.code(409).send({ error: 'A historical job is already running for this mailbox. Wait for it or cancel it first.' });
    const job = await prisma.historicalJob.create({ data: { ...b, dateFrom: new Date(b.dateFrom), dateTo: new Date(b.dateTo), createdById: req.user.id } });
    await (await getQueue()).send(QUEUES.historical, { jobId: job.id } satisfies HistoricalJobMsg);
    await audit(req.user.id, 'HISTORICAL_JOB_CREATED', 'HistoricalJob', job.id, null, b, req.ip);
    return job;
  });

  app.post('/historical-jobs/:id/cancel', { preHandler: requirePermission('ruleTesting', 'execute') }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { count } = await prisma.historicalJob.updateMany({ where: { id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED', finishedAt: new Date() } });
    if (!count) return reply.code(400).send({ error: 'Only queued or running jobs can be cancelled' });
    await audit(req.user.id, 'HISTORICAL_JOB_CANCELLED', 'HistoricalJob', id, null, null, req.ip);
    return { ok: true };
  });

  app.post('/historical-jobs/:id/resume', { preHandler: requirePermission('ruleTesting', 'execute') }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { count } = await prisma.historicalJob.updateMany({ where: { id, status: { in: ['CANCELLED', 'FAILED'] } }, data: { status: 'QUEUED', finishedAt: null } });
    if (!count) return reply.code(400).send({ error: 'Only cancelled or failed jobs can be resumed' });
    await (await getQueue()).send(QUEUES.historical, { jobId: id } satisfies HistoricalJobMsg);
    await audit(req.user.id, 'HISTORICAL_JOB_RESUMED', 'HistoricalJob', id, null, null, req.ip);
    return { ok: true };
  });
}
