import { buildDestinationFolder, evaluateConditions, filterAttachments, type AttachmentInfo, type MailProvider } from '@mailvault/core';
import { prisma, Prisma, type DownloadStatus } from '@mailvault/db';
import { attachmentFilterSchema, downloadConfigSchema, ruleConditionsSchema } from '@mailvault/shared';
import { plog } from './alerts.js';
import type { PipelineContext } from './context.js';

const KIND = { file: 'FILE', item: 'ITEM', reference: 'REFERENCE', unknown: 'UNKNOWN' } as const;
const toInfo = (a: { providerAttachmentId: string; name: string; contentType: string | null; sizeBytes: number; isInline: boolean; kind: string }): AttachmentInfo => ({
  id: a.providerAttachmentId,
  name: a.name,
  contentType: a.contentType ?? undefined,
  size: a.sizeBytes,
  isInline: a.isInline,
  kind: (Object.entries(KIND).find(([, v]) => v === a.kind)?.[0] ?? 'unknown') as AttachmentInfo['kind'],
});

/**
 * Matches every not-yet-evaluated email of a mailbox against its active rules (priority order).
 * One failing email never blocks the others; it is retried on the next sync.
 */
export async function evaluateMailbox(mailboxId: string, ctx: PipelineContext): Promise<{ evaluated: number; matched: number }> {
  const mb = await prisma.mailbox.findUniqueOrThrow({ where: { id: mailboxId } });
  const rules = await prisma.rule.findMany({ where: { mailboxId, enabled: true }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }], include: { destination: true } });
  const settings = await ctx.settings();
  const policy = { blockedExtensions: settings.blockedExtensions, maxSizeMb: settings.maxSizeMb, includeInline: settings.includeInline };

  let evaluated = 0;
  let matched = 0;
  let provider: MailProvider | null = null;
  const failedThisRun: string[] = [];
  const getProvider = () => (provider ??= ctx.providerFor(mb));

  for (;;) {
    const messages = await prisma.message.findMany({
      where: { mailboxId, evaluatedAt: null, id: { notIn: failedThisRun } },
      orderBy: { receivedAt: 'asc' },
      take: 100,
    });
    if (!messages.length) break;

    for (const msg of messages) {
      try {
        let body: string | undefined;
        let attachments: AttachmentInfo[] | null = null;
        let anyMatch = false;

        for (const rule of rules) {
          if (rule.effectiveFrom > msg.receivedAt) continue; // rule changes apply to future mail only
          const conditions = ruleConditionsSchema.parse(rule.conditions);
          const facts = { from: msg.fromEmail, to: msg.toEmails, cc: msg.ccEmails, subject: msg.subject, receivedAt: msg.receivedAt };
          let ev = evaluateConditions(conditions, facts);
          if (ev.needsBody) {
            body ??= await getProvider().getBodyText({ mailbox: mb.email, messageId: msg.providerMessageId });
            ev = evaluateConditions(conditions, facts, body);
          }
          if (!ev.matched) continue;

          // Attachments are listed once per email and stored, even when several rules match.
          if (attachments === null) {
            const stored = await prisma.attachment.findMany({ where: { messageId: msg.id } });
            if (stored.length || !msg.hasAttachments) {
              attachments = stored.map(toInfo);
            } else {
              const listed = await getProvider().listAttachments({ mailbox: mb.email, messageId: msg.providerMessageId });
              await prisma.attachment.createMany({
                skipDuplicates: true,
                data: listed.map((a) => ({
                  messageId: msg.id,
                  providerAttachmentId: a.id,
                  name: a.name,
                  contentType: a.contentType,
                  sizeBytes: a.size,
                  isInline: a.isInline,
                  kind: KIND[a.kind],
                })),
              });
              attachments = listed;
            }
          }

          const created = await createMatch(msg, rule, attachments, policy, settings.timeZone, mb.email);
          if (created) {
            anyMatch = true;
            await plog('info', 'rules', `"${msg.subject}" matched rule "${rule.name}"`, { mailboxId, correlationId: created });
          }
          if (rule.stopFurtherRules) break;
        }

        await prisma.message.update({ where: { id: msg.id }, data: { evaluatedAt: ctx.now() } });
        evaluated++;
        if (anyMatch) matched++;
      } catch (err) {
        failedThisRun.push(msg.id);
        await plog('error', 'rules', `Could not evaluate "${msg.subject}" from ${msg.fromEmail}: ${(err as Error).message}. Will retry on next sync.`, { mailboxId });
      }
    }
  }
  return { evaluated, matched };
}

type RuleWithDest = Prisma.RuleGetPayload<{ include: { destination: true } }>;

/** Creates the rule match and one download row per attachment. Returns the correlation ID, or null if already processed. */
async function createMatch(
  msg: { id: string; fromEmail: string; fromName: string | null; subject: string; receivedAt: Date },
  rule: RuleWithDest,
  attachments: AttachmentInfo[],
  policy: { blockedExtensions: string[]; maxSizeMb: number; includeInline: boolean },
  timeZone: string,
  mailboxEmail: string,
): Promise<string | null> {
  const filter = attachmentFilterSchema.parse(rule.attachments);
  const download = downloadConfigSchema.parse(rule.download);
  const decisions = filterAttachments(filter, attachments, policy);
  const stored = await prisma.attachment.findMany({ where: { messageId: msg.id }, select: { id: true, providerAttachmentId: true } });
  const idOf = new Map(stored.map((s) => [s.providerAttachmentId, s.id]));

  const simulatedFolder = rule.simulationMode
    ? buildDestinationFolder(rule.destination.basePath, download, {
        receivedAt: msg.receivedAt,
        timeZone,
        senderEmail: msg.fromEmail,
        senderName: msg.fromName ?? undefined,
        subject: msg.subject,
        ruleName: rule.name,
        mailbox: mailboxEmail,
      })
    : '';

  try {
    const match = await prisma.messageRuleMatch.create({
      data: {
        messageId: msg.id,
        ruleId: rule.id,
        ruleVersion: rule.currentVersion,
        downloads: {
          create: decisions
            .filter((d) => idOf.has(d.attachment.id))
            .map((d) => {
              let status: DownloadStatus = 'PENDING';
              let skipReason: string | undefined;
              if (!d.include) {
                status = 'SKIPPED';
                skipReason = d.reason;
              } else if (rule.simulationMode) {
                status = 'SKIPPED';
                skipReason = `Simulation: would save to ${simulatedFolder}\\${d.saveName}`;
              } else if (!rule.autoDownload) {
                status = 'AWAITING_MANUAL';
              }
              return { attachmentId: idOf.get(d.attachment.id)!, status, skipReason, finalFileName: d.saveName };
            }),
        },
      },
    });
    return match.correlationId;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null; // already processed for this rule
    throw err;
  }
}
