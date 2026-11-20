import { emitWebhookEvent, prisma } from '@mailvault/db';
import { GraphError, explainGraphError } from '@mailvault/m365';
import { downloadConfigSchema, type ManualDownloadJob } from '@mailvault/shared';
import { plog } from './alerts.js';
import type { PipelineContext } from './context.js';
import { ensureMessage, processMessage, type RuleWithDest } from './evaluate.js';

interface Checkpoint {
  folderIndex: number;
  cursor: string | null;
}

/**
 * Runs an admin-requested historical job: searches the mailbox's monitored folders for the date range,
 * applies the chosen rules (Simulate or Execute) and saves progress after every page so it can resume.
 */
export async function runHistoricalJob(jobId: string, ctx: PipelineContext): Promise<void> {
  const job = await prisma.historicalJob.findUnique({ where: { id: jobId } });
  if (!job || job.status === 'COMPLETED' || job.status === 'CANCELLED') return;

  const mb = await prisma.mailbox.findUniqueOrThrow({ where: { id: job.mailboxId }, include: { folders: { orderBy: { displayName: 'asc' } } } });
  const rules: RuleWithDest[] = await prisma.rule.findMany({
    where: job.ruleIds.length ? { id: { in: job.ruleIds } } : { mailboxId: mb.id, enabled: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    include: { destination: true },
  });
  const settings = await ctx.settings();
  const cp: Checkpoint = job.checkpoint ? (JSON.parse(job.checkpoint) as Checkpoint) : { folderIndex: 0, cursor: null };
  let { scanned, matched, downloaded } = job;

  await prisma.historicalJob.update({ where: { id: jobId }, data: { status: 'RUNNING' } });
  const mode = job.simulate ? 'simulation' : 'execution';
  if (!job.checkpoint) await plog('info', 'historical', `Historical ${mode} started for ${mb.email} (${rules.length} rule(s))`, { mailboxId: mb.id });

  try {
    const provider = ctx.providerFor(mb);
    for (; cp.folderIndex < mb.folders.length; cp.folderIndex++, cp.cursor = null) {
      const folder = mb.folders[cp.folderIndex]!;
      do {
        const page = await provider.search({
          mailbox: mb.email,
          folderId: folder.providerFolderId,
          receivedFrom: job.dateFrom,
          receivedTo: job.dateTo,
          // Emails without attachments matter only to rules that save the email itself as PDF.
          onlyWithAttachments: !rules.some((r) => downloadConfigSchema.parse(r.download).emailPdf !== 'OFF'),
          pageSize: 50,
          pageCursor: cp.cursor,
        });
        for (const env of page.messages) {
          const msg = await ensureMessage(mb, env, ctx.now());
          const r = await processMessage(
            mb,
            msg,
            rules,
            { trigger: 'HISTORICAL', triggeredById: job.createdById, ignoreEffectiveFrom: true, simulate: job.simulate, reprocess: job.includeProcessed },
            ctx,
            settings,
          );
          scanned++;
          if (r.matchedRules) matched++;
          downloaded += r.queuedDownloads;
        }
        cp.cursor = page.nextCursor;
        const latest = await prisma.historicalJob.update({
          where: { id: jobId },
          data: { scanned, matched, downloaded, checkpoint: JSON.stringify(cp) },
        });
        if (latest.status === 'CANCELLED') {
          await plog('warn', 'historical', `Historical job for ${mb.email} cancelled after ${scanned} email(s)`, { mailboxId: mb.id });
          return;
        }
      } while (cp.cursor);
    }

    await prisma.historicalJob.update({ where: { id: jobId }, data: { status: 'COMPLETED', finishedAt: ctx.now(), checkpoint: null } });
    const summary = `${scanned} email(s) scanned, ${matched} matched${job.simulate ? ' (simulation, nothing saved)' : `, ${downloaded} file(s) queued`}`;
    await plog('info', 'historical', `Historical ${mode} finished for ${mb.email}: ${summary}`, { mailboxId: mb.id });
    await emitWebhookEvent('job.completed', { jobId, mailbox: mb.email, mode: job.simulate ? 'simulate' : 'execute', dateFrom: job.dateFrom.toISOString(), dateTo: job.dateTo.toISOString(), scanned, matched, filesQueued: downloaded }, { mailboxId: mb.id });
    if (job.createdById) {
      await prisma.notification.create({
        data: {
          type: 'HISTORICAL_DONE',
          severity: 'SUCCESS',
          title: `Historical ${mode} finished: ${mb.email}`,
          message: summary,
          link: '/historical-jobs',
          recipients: { create: { userId: job.createdById } },
        },
      });
    }
  } catch (err) {
    const message = err instanceof GraphError ? explainGraphError(err) : (err as Error).message;
    await prisma.historicalJob.update({ where: { id: jobId }, data: { status: 'FAILED', finishedAt: ctx.now() } });
    await plog('error', 'historical', `Historical job for ${mb.email} failed: ${message}. It can be resumed.`, { mailboxId: mb.id, data: { jobId } });
    throw err;
  }
}

/** "Download selected attachments" from Rule Testing: explicit, so it may reprocess an email. */
export async function runManualDownload(job: ManualDownloadJob, ctx: PipelineContext): Promise<number> {
  const mb = await prisma.mailbox.findUniqueOrThrow({ where: { id: job.mailboxId } });
  const rule = await prisma.rule.findUniqueOrThrow({ where: { id: job.ruleId }, include: { destination: true } });
  const env = await ctx.providerFor(mb).getMessage({ mailbox: mb.email, messageId: job.providerMessageId });
  const msg = await ensureMessage(mb, env, ctx.now());
  const r = await processMessage(
    mb,
    msg,
    [rule],
    { trigger: 'RULE_TEST', triggeredById: job.userId, ignoreEffectiveFrom: true, reprocess: true, onlyAttachmentIds: job.attachmentIds },
    ctx,
    await ctx.settings(),
  );
  return r.queuedDownloads;
}
