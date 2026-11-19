import { CursorExpiredError } from '@mailvault/core';
import { prisma, type ProcessTrigger } from '@mailvault/db';
import { GraphError, explainGraphError } from '@mailvault/m365';
import { log } from '../env.js';
import { plog, raiseAlert, resolveAlert } from './alerts.js';
import { NotConfiguredError, type PipelineContext } from './context.js';
import { evaluateMailbox } from './evaluate.js';

export interface SyncResult {
  scanned: number;
  newMessages: number;
  matched: number;
  error?: string;
}

/**
 * Syncs one mailbox: delta per monitored folder → new messages saved together with the new
 * sync position (one transaction, so nothing is lost or duplicated) → rule matching.
 */
export async function syncMailbox(mailboxId: string, trigger: ProcessTrigger, ctx: PipelineContext): Promise<SyncResult> {
  const mb = await prisma.mailbox.findUnique({ where: { id: mailboxId }, include: { folders: true } });
  if (!mb) return { scanned: 0, newMessages: 0, matched: 0, error: 'Mailbox not found' };
  if (!mb.enabled) return { scanned: 0, newMessages: 0, matched: 0, error: 'Monitoring is disabled for this mailbox' };

  const run = await prisma.syncRun.create({ data: { mailboxId, trigger } });
  await prisma.mailbox.update({ where: { id: mailboxId }, data: { status: 'SYNCING' } });

  let scanned = 0;
  let newMessages = 0;
  try {
    const provider = ctx.providerFor(mb);

    for (const folder of mb.folders) {
      const firstStart = mb.monitoringStartAt;
      let batch;
      try {
        batch = await provider.getChanges({ mailbox: mb.email, folderId: folder.providerFolderId, cursor: folder.deltaLink, receivedAfter: firstStart });
      } catch (err) {
        if (!(err instanceof CursorExpiredError)) throw err;
        // Re-sync from a little before the last successful sync; unique keys drop anything already saved.
        const since = new Date(Math.max(firstStart.getTime(), (folder.lastSyncAt?.getTime() ?? firstStart.getTime()) - 24 * 3600_000));
        await plog('warn', 'sync', `Sync position expired for ${mb.email}/${folder.displayName}; re-syncing from ${since.toISOString()}`, { mailboxId });
        batch = await provider.getChanges({ mailbox: mb.email, folderId: folder.providerFolderId, cursor: null, receivedAfter: since });
      }

      const fresh = batch.messages.filter((m) => m.receivedAt >= firstStart && m.from.email);
      scanned += batch.messages.length;
      const [created] = await prisma.$transaction([
        prisma.message.createMany({
          skipDuplicates: true,
          data: fresh.map((m) => ({
            mailboxId,
            providerMessageId: m.providerMessageId,
            internetMessageId: m.internetMessageId,
            folderId: m.folderId,
            fromEmail: m.from.email,
            fromName: m.from.name,
            toEmails: m.to.map((a) => a.email).filter(Boolean),
            ccEmails: m.cc.map((a) => a.email).filter(Boolean),
            subject: m.subject,
            receivedAt: m.receivedAt,
            hasAttachments: m.hasAttachments,
          })),
        }),
        prisma.mailboxFolder.update({ where: { id: folder.id }, data: { deltaLink: batch.cursor || folder.deltaLink, lastSyncAt: ctx.now() } }),
      ]);
      newMessages += created.count;
    }

    const { matched } = await evaluateMailbox(mailboxId, ctx);
    const now = ctx.now();
    await prisma.syncRun.update({ where: { id: run.id }, data: { finishedAt: now, messagesScanned: scanned, newMessages, messagesMatched: matched } });
    await prisma.mailbox.update({ where: { id: mailboxId }, data: { status: 'CONNECTED', lastSyncAt: now, lastSuccessAt: now, lastError: null } });
    await resolveAlert(`MAILBOX:${mailboxId}`, `Mailbox connected again: ${mb.email}`, 'Email processing has resumed.', '/accounts');
    if (newMessages > 0) {
      await plog('info', 'sync', `Sync ${mb.email}: ${newMessages} new email(s), ${matched} matched a rule`, { mailboxId, correlationId: run.correlationId });
    }
    return { scanned, newMessages, matched };
  } catch (err) {
    const message =
      err instanceof NotConfiguredError ? err.message : err instanceof GraphError ? explainGraphError(err) : (err as Error).message;
    const authProblem = err instanceof GraphError && (err.status === 401 || err.status === 403);
    const status = err instanceof NotConfiguredError ? 'WARNING' : authProblem ? 'DISCONNECTED' : 'WARNING';
    log.warn({ mailbox: mb.email, err: message }, 'mailbox sync failed');

    await prisma.syncRun.update({ where: { id: run.id }, data: { finishedAt: ctx.now(), messagesScanned: scanned, newMessages, error: message } });
    await prisma.mailbox.update({ where: { id: mailboxId }, data: { status, lastSyncAt: ctx.now(), lastError: message } });
    await plog('error', 'sync', `Sync failed for ${mb.email}: ${message}`, { mailboxId, correlationId: run.correlationId });
    if (authProblem) {
      await raiseAlert({
        key: `MAILBOX:${mailboxId}`,
        type: 'MAILBOX_DISCONNECTED',
        severity: 'ERROR',
        title: `Mailbox disconnected: ${mb.email}`,
        message,
        link: '/accounts',
      });
    }
    return { scanned, newMessages, matched: 0, error: message };
  }
}

/** Mailboxes whose sync interval has passed. */
export async function dueMailboxes(ctx: PipelineContext): Promise<string[]> {
  const { syncIntervalMinutes } = await ctx.settings();
  const now = ctx.now().getTime();
  const rows = await prisma.mailbox.findMany({
    where: { enabled: true, status: { notIn: ['DISABLED', 'REAUTH_REQUIRED', 'SYNCING'] } },
    select: { id: true, lastSyncAt: true, syncIntervalMinutes: true },
  });
  return rows
    .filter((m) => !m.lastSyncAt || now - m.lastSyncAt.getTime() >= (m.syncIntervalMinutes ?? syncIntervalMinutes) * 60_000 - 5_000)
    .map((m) => m.id);
}
