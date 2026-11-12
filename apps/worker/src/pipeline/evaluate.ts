import { buildDestinationFolder, evaluateConditions, filterAttachments, type AttachmentInfo, type MailEnvelope, type MailProvider } from '@mailvault/core';
import { prisma, Prisma, type DownloadStatus, type Mailbox, type Message, type ProcessTrigger } from '@mailvault/db';
import { attachmentFilterSchema, downloadConfigSchema, ruleConditionsSchema } from '@mailvault/shared';
import { plog } from './alerts.js';
import type { PipelineContext, PipelineSettings } from './context.js';

const KIND = { file: 'FILE', item: 'ITEM', reference: 'REFERENCE', unknown: 'UNKNOWN' } as const;
const toInfo = (a: { providerAttachmentId: string; name: string; contentType: string | null; sizeBytes: number; isInline: boolean; kind: string }): AttachmentInfo => ({
  id: a.providerAttachmentId,
  name: a.name,
  contentType: a.contentType ?? undefined,
  size: a.sizeBytes,
  isInline: a.isInline,
  kind: (Object.entries(KIND).find(([, v]) => v === a.kind)?.[0] ?? 'unknown') as AttachmentInfo['kind'],
});

export type RuleWithDest = Prisma.RuleGetPayload<{ include: { destination: true } }>;

export interface ProcessOptions {
  trigger: ProcessTrigger;
  triggeredById?: string | null;
  /** Historical/manual runs apply rules to mail received before the rule existed. */
  ignoreEffectiveFrom?: boolean;
  /** Force simulation (historical "Simulate" mode) regardless of the rule's own setting. */
  simulate?: boolean;
  /** Process again even if this rule already handled the email (creates a new run number). */
  reprocess?: boolean;
  /** Manual download: only these provider attachment IDs; the rule's conditions are not checked. */
  onlyAttachmentIds?: string[];
}

export interface ProcessResult {
  matchedRules: number;
  queuedDownloads: number;
}

/** Per-email cache so the body and attachment list are fetched at most once. */
interface MessageCache {
  body?: string;
  attachments?: AttachmentInfo[];
}

/** Inserts (or finds) a message row for an email fetched from the mailbox. */
export async function ensureMessage(mb: Mailbox, env: MailEnvelope, now: Date): Promise<Message> {
  const existing = await prisma.message.findUnique({ where: { mailboxId_providerMessageId: { mailboxId: mb.id, providerMessageId: env.providerMessageId } } });
  if (existing) return existing;
  return prisma.message
    .create({
      data: {
        mailboxId: mb.id,
        providerMessageId: env.providerMessageId,
        internetMessageId: env.internetMessageId,
        folderId: env.folderId,
        fromEmail: env.from.email || 'unknown',
        fromName: env.from.name,
        toEmails: env.to.map((a) => a.email).filter(Boolean),
        ccEmails: env.cc.map((a) => a.email).filter(Boolean),
        subject: env.subject,
        receivedAt: env.receivedAt,
        hasAttachments: env.hasAttachments,
        // Older than the monitoring window: automatic processing never looks at it.
        // Inside the window: left for automatic processing so the other rules still run.
        evaluatedAt: env.receivedAt < mb.monitoringStartAt ? now : null,
      },
    })
    .catch(async (err) => {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return prisma.message.findUniqueOrThrow({ where: { mailboxId_providerMessageId: { mailboxId: mb.id, providerMessageId: env.providerMessageId } } });
      }
      throw err;
    });
}

/** Applies rules (priority order) to one stored email. Shared by automatic sync, historical jobs and manual downloads. */
export async function processMessage(
  mb: Mailbox,
  msg: Message,
  rules: RuleWithDest[],
  opts: ProcessOptions,
  ctx: PipelineContext,
  settings: PipelineSettings,
  cache: MessageCache = {},
): Promise<ProcessResult> {
  let provider: MailProvider | null = null;
  const getProvider = () => (provider ??= ctx.providerFor(mb));
  const ref = { mailbox: mb.email, messageId: msg.providerMessageId };
  const result: ProcessResult = { matchedRules: 0, queuedDownloads: 0 };

  for (const rule of rules) {
    if (!opts.ignoreEffectiveFrom && rule.effectiveFrom > msg.receivedAt) continue; // rule changes apply to future mail only

    if (!opts.onlyAttachmentIds) {
      const conditions = ruleConditionsSchema.parse(rule.conditions);
      const facts = { from: msg.fromEmail, to: msg.toEmails, cc: msg.ccEmails, subject: msg.subject, receivedAt: msg.receivedAt };
      let ev = evaluateConditions(conditions, facts);
      if (ev.needsBody) {
        cache.body ??= await getProvider().getBodyText(ref);
        ev = evaluateConditions(conditions, facts, cache.body);
      }
      if (!ev.matched) continue;
    }

    // Attachments are listed once per email and stored, even when several rules match.
    if (!cache.attachments) {
      const stored = await prisma.attachment.findMany({ where: { messageId: msg.id } });
      if (stored.length || !msg.hasAttachments) {
        cache.attachments = stored.map(toInfo);
      } else {
        const listed = await getProvider().listAttachments(ref);
        await prisma.attachment.createMany({
          skipDuplicates: true,
          data: listed.map((a) => ({ messageId: msg.id, providerAttachmentId: a.id, name: a.name, contentType: a.contentType, sizeBytes: a.size, isInline: a.isInline, kind: KIND[a.kind] })),
        });
        cache.attachments = listed;
      }
    }

    const created = await createMatch(mb, msg, rule, cache.attachments, opts, settings);
    if (created) {
      result.matchedRules++;
      result.queuedDownloads += created.queued;
      const how = opts.trigger === 'AUTO' ? 'matched' : opts.trigger === 'HISTORICAL' ? 'matched (historical job)' : 'queued manually for';
      await plog('info', 'rules', `"${msg.subject}" ${how} rule "${rule.name}"`, { mailboxId: mb.id, correlationId: created.correlationId });
    }
    if (rule.stopFurtherRules && !opts.onlyAttachmentIds) break;
  }
  return result;
}

/**
 * Matches every not-yet-evaluated email of a mailbox against its active rules.
 * One failing email never blocks the others; it is retried on the next sync.
 */
export async function evaluateMailbox(mailboxId: string, ctx: PipelineContext): Promise<{ evaluated: number; matched: number }> {
  const mb = await prisma.mailbox.findUniqueOrThrow({ where: { id: mailboxId } });
  const rules = await prisma.rule.findMany({ where: { mailboxId, enabled: true }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }], include: { destination: true } });
  const settings = await ctx.settings();

  let evaluated = 0;
  let matched = 0;
  const failedThisRun: string[] = [];

  for (;;) {
    const messages = await prisma.message.findMany({ where: { mailboxId, evaluatedAt: null, id: { notIn: failedThisRun } }, orderBy: { receivedAt: 'asc' }, take: 100 });
    if (!messages.length) break;
    for (const msg of messages) {
      try {
        const r = await processMessage(mb, msg, rules, { trigger: 'AUTO' }, ctx, settings);
        await prisma.message.update({ where: { id: msg.id }, data: { evaluatedAt: ctx.now() } });
        evaluated++;
        if (r.matchedRules > 0) matched++;
      } catch (err) {
        failedThisRun.push(msg.id);
        await plog('error', 'rules', `Could not evaluate "${msg.subject}" from ${msg.fromEmail}: ${(err as Error).message}. Will retry on next sync.`, { mailboxId });
      }
    }
  }
  return { evaluated, matched };
}

/** Creates the rule match and one download row per attachment. Returns null if this rule already processed the email. */
async function createMatch(
  mb: Mailbox,
  msg: Message,
  rule: RuleWithDest,
  attachments: AttachmentInfo[],
  opts: ProcessOptions,
  settings: PipelineSettings,
): Promise<{ correlationId: string; queued: number } | null> {
  const policy = { blockedExtensions: settings.blockedExtensions, maxSizeMb: settings.maxSizeMb, includeInline: settings.includeInline };
  const download = downloadConfigSchema.parse(rule.download);
  const manual = opts.onlyAttachmentIds;
  // Manual downloads skip the rule's attachment filters but keep the safety checks (blocked types, size, cloud links).
  const filter = manual
    ? attachmentFilterSchema.parse({ mode: 'ALL', allowMultiple: true, includeInline: true })
    : attachmentFilterSchema.parse(rule.attachments);
  const decisions = filterAttachments(filter, attachments, policy).map((d) =>
    manual && !manual.includes(d.attachment.id) ? { ...d, include: false, reason: 'Not selected for manual download' } : d,
  );

  const stored = await prisma.attachment.findMany({ where: { messageId: msg.id }, select: { id: true, providerAttachmentId: true } });
  const idOf = new Map(stored.map((s) => [s.providerAttachmentId, s.id]));
  const simulate = !manual && (opts.simulate || rule.simulationMode);
  const folder = simulate
    ? buildDestinationFolder(rule.destination.basePath, download, {
        receivedAt: msg.receivedAt,
        timeZone: settings.timeZone,
        senderEmail: msg.fromEmail,
        senderName: msg.fromName ?? undefined,
        subject: msg.subject,
        ruleName: rule.name,
        mailbox: mb.email,
      })
    : '';

  let runNumber = 1;
  if (opts.reprocess) {
    const last = await prisma.messageRuleMatch.findFirst({ where: { messageId: msg.id, ruleId: rule.id }, orderBy: { runNumber: 'desc' } });
    runNumber = (last?.runNumber ?? 0) + 1;
  }

  let queued = 0;
  const rows = decisions
    .filter((d) => idOf.has(d.attachment.id))
    .map((d) => {
      let status: DownloadStatus = 'PENDING';
      let skipReason: string | undefined;
      if (!d.include) {
        status = 'SKIPPED';
        skipReason = d.reason;
      } else if (simulate) {
        status = 'SKIPPED';
        skipReason = `Simulation: would save to ${folder}\\${d.saveName}`;
      } else if (!manual && !rule.autoDownload) {
        status = 'AWAITING_MANUAL';
      } else {
        queued++;
      }
      return { attachmentId: idOf.get(d.attachment.id)!, status, skipReason, finalFileName: d.saveName };
    });

  try {
    const match = await prisma.messageRuleMatch.create({
      data: {
        messageId: msg.id,
        ruleId: rule.id,
        ruleVersion: rule.currentVersion,
        trigger: opts.trigger,
        triggeredById: opts.triggeredById ?? null,
        runNumber,
        downloads: { create: rows },
      },
    });
    return { correlationId: match.correlationId, queued };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null; // already processed for this rule
    throw err;
  }
}
