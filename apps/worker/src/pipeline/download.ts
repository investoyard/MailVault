import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { acceptInnerFile, buildDestinationFolder, containerKindOf, renderPattern, sanitizeFileName, type AttachmentInfo, type ContainerKind } from '@mailvault/core';
import { DEFAULT_LIMITS, ExtractError, FileTooLargeError, assertRootExists, explainFsError, extractToTemp, saveAttachment } from '@mailvault/core/node';
import { emitWebhookEvent, prisma, type DuplicatePolicy, type Prisma } from '@mailvault/db';
import { GraphError, explainGraphError } from '@mailvault/m365';
import { attachmentFilterSchema, downloadConfigSchema, type AttachmentFilter } from '@mailvault/shared';
import { log } from '../env.js';
import { plog, raiseAlert } from './alerts.js';
import { NotConfiguredError, type PipelineContext, type PipelineSettings } from './context.js';

const UNREACHABLE = new Set(['ENOENT', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED', 'EBADF', 'UNKNOWN']);
const PERMANENT_FS = new Set(['ENAMETOOLONG', 'EINVAL']);

type Outcome =
  | { kind: 'retry'; code: string; message: string }
  | { kind: 'fail'; code: string; message: string }
  | { kind: 'wait'; code: string; message: string };

/** Sorts errors into: try again later, give up now, or wait for the destination folder. */
export function classifyError(err: unknown): Outcome {
  if (err instanceof NotConfiguredError) return { kind: 'retry', code: 'NOT_CONFIGURED', message: err.message };
  if (err instanceof FileTooLargeError) return { kind: 'fail', code: 'TOO_LARGE', message: err.message };
  if (err instanceof ExtractError) return { kind: 'fail', code: 'EXTRACT_FAILED', message: err.message };
  if (err instanceof GraphError) {
    if (err.status === 404) return { kind: 'fail', code: 'SOURCE_GONE', message: 'The email or attachment no longer exists in the mailbox' };
    return { kind: 'retry', code: `GRAPH_${err.status || 'NETWORK'}`, message: explainGraphError(err) };
  }
  const e = err as NodeJS.ErrnoException;
  if (e?.code && UNREACHABLE.has(e.code)) return { kind: 'wait', code: 'DEST_UNAVAILABLE', message: `Destination folder unavailable: ${explainFsError(e)}` };
  if (e?.code && PERMANENT_FS.has(e.code)) return { kind: 'fail', code: e.code, message: explainFsError(e) };
  if (e?.code) return { kind: 'retry', code: e.code, message: explainFsError(e) };
  return { kind: 'retry', code: 'UNKNOWN', message: (err as Error)?.message ?? String(err) };
}

/** Next wait in minutes for the given attempt number (1-based), using the Settings list. */
export function backoffMinutes(attempt: number, s: PipelineSettings): number {
  const list = s.retryIntervalsMinutes.length ? s.retryIntervalsMinutes : [1, 5, 15, 60];
  return list[Math.min(attempt - 1, list.length - 1)]!;
}

/** Atomically claims due downloads so two workers never take the same one. */
// Prisma stores timestamps as UTC "timestamp without time zone", so compare against a UTC value we pass in
// (never Postgres now(), which follows the session time zone).
async function claim(limit: number, now: Date): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "AttachmentDownload" SET status = 'IN_PROGRESS', "updatedAt" = ${new Date()}
    WHERE id IN (
      SELECT id FROM "AttachmentDownload"
      WHERE status IN ('PENDING', 'RETRYING', 'WAITING_DESTINATION')
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
      ORDER BY "createdAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
  return rows.map((r) => r.id);
}

/** Puts downloads stuck IN_PROGRESS (e.g. worker crashed mid-file) back in the queue. */
export async function recoverStuckDownloads(olderThanMinutes = 15) {
  const { count } = await prisma.attachmentDownload.updateMany({
    where: { status: 'IN_PROGRESS', updatedAt: { lt: new Date(Date.now() - olderThanMinutes * 60_000) } },
    data: { status: 'RETRYING', nextAttemptAt: new Date() },
  });
  if (count) log.warn({ count }, 'recovered stuck downloads');
  return count;
}

export async function processDownloads(ctx: PipelineContext, opts: { batchSize?: number; concurrency?: number } = {}) {
  const settings = await ctx.settings();
  let total = 0;
  const seen = new Set<string>();
  for (;;) {
    const ids = await claim(opts.batchSize ?? 20, ctx.now());
    if (!ids.length) break;
    // Safety: never handle the same download twice in one run (e.g. if a wait time computed as already due).
    const again = ids.filter((id) => seen.has(id));
    if (again.length) {
      await prisma.attachmentDownload.updateMany({ where: { id: { in: again } }, data: { status: 'RETRYING' } });
      if (again.length === ids.length) break;
    }
    ids.forEach((id) => seen.add(id));
    total += ids.length - again.length;
    ids.splice(0, ids.length, ...ids.filter((id) => !again.includes(id)));
    const queue = [...ids];
    const workers = Array.from({ length: Math.min(opts.concurrency ?? 3, queue.length) }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) await downloadOne(id, ctx, settings);
    });
    await Promise.all(workers);
  }
  return total;
}

async function downloadOne(id: string, ctx: PipelineContext, settings: PipelineSettings) {
  const row = await prisma.attachmentDownload.findUniqueOrThrow({
    where: { id },
    include: {
      attachment: true,
      match: { include: { rule: { include: { destination: true } }, message: { include: { mailbox: true } } } },
    },
  });
  const { rule, message } = row.match;
  const dest = rule.destination;
  const correlationId = row.match.correlationId;
  const attempt = row.attempts + 1;
  const eventData = (file: Record<string, unknown>) => ({
    downloadId: id,
    file,
    email: {
      mailbox: message.mailbox.email,
      from: message.fromEmail,
      subject: message.subject,
      receivedAt: message.receivedAt.toISOString(),
      internetMessageId: message.internetMessageId,
    },
    rule: { id: rule.id, name: rule.name },
    attachment: { name: row.attachment.name, sizeBytes: row.attachment.sizeBytes },
  });
  const scope = { mailboxId: message.mailboxId, ruleId: rule.id };

  try {
    if (dest.status === 'UNAVAILABLE' && dest.lastCheckedAt && ctx.now().getTime() - dest.lastCheckedAt.getTime() < 5 * 60_000) {
      throw Object.assign(new Error(dest.lastError ?? 'Destination folder unavailable'), { code: 'ENOENT' });
    }

    const cfg = downloadConfigSchema.parse(rule.download);
    const pctx = {
      receivedAt: message.receivedAt,
      timeZone: settings.timeZone,
      senderEmail: message.fromEmail,
      senderName: message.fromName ?? undefined,
      subject: message.subject,
      ruleName: rule.name,
      mailbox: message.mailbox.email,
    };
    const folder = buildDestinationFolder(dest.basePath, cfg, pctx);
    const original = row.finalFileName ?? row.attachment.name;
    const pattern = cfg.fileNamePattern?.trim() || '{OriginalName}';
    const targetName = (orig: string) => {
      let name = sanitizeFileName(pattern === '{OriginalName}' ? orig : renderPattern(pattern, { ...pctx, originalName: orig }));
      // Patterns like "{yyyyMMdd}_{OriginalName}" already include the extension; add it if a pattern dropped it.
      const ext = orig.includes('.') ? orig.slice(orig.lastIndexOf('.')) : '';
      if (ext && !name.toLowerCase().endsWith(ext.toLowerCase())) name = sanitizeFileName(name + ext);
      return name;
    };
    const fileName = targetName(original);
    const saveOpts = { folder, policy: rule.duplicatePolicy, fileDate: cfg.setFileDateToReceived ? message.receivedAt : undefined, maxBytes: settings.maxSizeMb * 1024 * 1024 };

    const provider = ctx.providerFor(message.mailbox);
    const source = await provider.openAttachment({ mailbox: message.mailbox.email, messageId: message.providerMessageId }, row.attachment.providerAttachmentId);

    // ZIP / attached email that the rule wants unpacked?
    const filter = attachmentFilterSchema.parse(rule.attachments);
    const kind = containerKindOf(original, row.attachment.kind.toLowerCase() as AttachmentInfo['kind']);
    if (kind && ((kind === 'zip' && filter.extractArchives) || (kind !== 'zip' && filter.extractEmails))) {
      await unpackAndSave({ id, original, fileName, kind, source, filter, saveOpts, targetName, settings, ctx, correlationId, mailboxId: message.mailboxId, attempt, attachmentId: row.attachmentId, onSaved: (file) => emitWebhookEvent('file.saved', eventData(file), scope) });
      return;
    }

    const result = await saveAttachment({ source, fileName, ...saveOpts });

    await prisma.$transaction([
      prisma.attachmentDownload.update({
        where: { id },
        data: {
          status: result.status === 'SAVED' ? 'SUCCESS' : 'SKIPPED',
          skipReason: result.status === 'SKIPPED' ? result.reason : null,
          destinationPath: result.path,
          finalFileName: result.fileName,
          sha256: result.sha256,
          bytesWritten: BigInt(result.bytes),
          downloadedAt: result.status === 'SAVED' ? ctx.now() : null,
          attempts: attempt,
          errorCode: null,
          errorMessage: null,
          nextAttemptAt: null,
        },
      }),
      prisma.attachment.update({ where: { id: row.attachmentId }, data: { sha256: result.sha256 } }),
    ]);
    if (result.status === 'SAVED') {
      await emitWebhookEvent('file.saved', eventData({ name: result.fileName, path: result.path, sizeBytes: result.bytes, sha256: result.sha256 }), scope);
    }
    await plog('info', 'download', result.status === 'SAVED' ? `Saved ${result.path}` : `Skipped ${result.fileName}: ${result.reason}`, {
      correlationId,
      mailboxId: message.mailboxId,
    });
  } catch (err) {
    const o = classifyError(err);
    if (o.kind === 'wait') {
      await prisma.attachmentDownload.update({
        where: { id },
        data: { status: 'WAITING_DESTINATION', errorCode: o.code, errorMessage: o.message, nextAttemptAt: new Date(ctx.now().getTime() + 5 * 60_000) },
      });
      await prisma.destination.update({ where: { id: dest.id }, data: { status: 'UNAVAILABLE', lastError: o.message, lastCheckedAt: ctx.now() } });
      await plog('warn', 'download', `${row.attachment.name}: waiting for destination (${o.message})`, { correlationId, mailboxId: message.mailboxId });
      return;
    }
    const giveUp = o.kind === 'fail' || attempt >= settings.retryMaxAttempts;
    await prisma.attachmentDownload.update({
      where: { id },
      data: giveUp
        ? { status: 'FAILED', attempts: attempt, errorCode: o.code, errorMessage: o.message, nextAttemptAt: null }
        : { status: 'RETRYING', attempts: attempt, errorCode: o.code, errorMessage: o.message, nextAttemptAt: new Date(ctx.now().getTime() + backoffMinutes(attempt, settings) * 60_000) },
    });
    await plog(giveUp ? 'error' : 'warn', 'download', `${row.attachment.name}: ${o.message}${giveUp ? ` (failed after ${attempt} attempt(s))` : ` (attempt ${attempt}, will retry)`}`, {
      correlationId,
      mailboxId: message.mailboxId,
    });
    if (giveUp) {
      await emitWebhookEvent('file.failed', { ...eventData({ name: row.finalFileName ?? row.attachment.name }), error: { code: o.code, message: o.message } }, scope);
      const day = ctx.now().toISOString().slice(0, 10);
      await raiseAlert({
        key: `DOWNLOAD_FAILED:${day}`,
        type: 'DOWNLOAD_FAILED',
        severity: 'ERROR',
        title: 'Attachment downloads failed',
        message: `${row.attachment.name} (rule "${rule.name}") failed: ${o.message}. More failures today are listed in Download History.`,
        link: '/history?status=FAILED',
      });
    }
  }
}

interface UnpackInput {
  id: string;
  original: string;
  fileName: string;
  kind: ContainerKind;
  source: NodeJS.ReadableStream;
  filter: AttachmentFilter;
  saveOpts: { folder: string; policy: DuplicatePolicy; fileDate?: Date; maxBytes: number };
  targetName: (orig: string) => string;
  settings: PipelineSettings;
  ctx: PipelineContext;
  correlationId: string;
  mailboxId: string;
  attempt: number;
  attachmentId: string;
  onSaved: (file: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Downloads a ZIP / attached email to a temp folder next to the destination, unpacks the files the rule
 * wants (same filters as normal attachments), saves each one, and records every file found inside.
 */
async function unpackAndSave(u: UnpackInput) {
  const { folder } = u.saveOpts;
  await assertRootExists(folder);
  const work = join(folder, '.mailvault-tmp', randomUUID());
  await mkdir(work, { recursive: true });
  try {
    // 1. Container to a temp file (size-limited, never fully in memory for ZIPs).
    const containerPath = join(work, 'container');
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _e, cb) {
        bytes += chunk.length;
        if (bytes > u.saveOpts.maxBytes) return cb(new FileTooLargeError(`File is larger than ${Math.round(u.saveOpts.maxBytes / 1048576)} MB`));
        cb(null, chunk);
      },
    });
    await pipeline(u.source as Readable, limit, createWriteStream(containerPath));

    // 2. Unpack what the rule accepts.
    const policy = { blockedExtensions: u.settings.blockedExtensions, maxSizeMb: u.settings.maxSizeMb, includeInline: u.settings.includeInline };
    const limits = { ...DEFAULT_LIMITS, maxEntryBytes: u.saveOpts.maxBytes, maxTotalBytes: Math.max(u.saveOpts.maxBytes * 4, 512 * 1048576) };
    const extracted = await extractToTemp(containerPath, u.kind, join(work, 'files'), (name, size, inline) => acceptInnerFile(u.filter, name, size, inline, policy), limits);

    // 3. Save each file with the rule's naming and duplicate policy.
    await prisma.extractedFile.deleteMany({ where: { downloadId: u.id } }); // a retry starts clean
    const rows: Prisma.ExtractedFileCreateManyInput[] = [];
    let saved = 0;
    for (const f of extracted.files) {
      const r = await saveAttachment({ ...u.saveOpts, source: createReadStream(f.tmpPath), fileName: u.targetName(f.name) });
      if (r.status === 'SAVED') {
        saved++;
        await u.onSaved({ name: r.fileName, path: r.path, sizeBytes: r.bytes, sha256: r.sha256, extractedFrom: { name: u.original, innerPath: f.innerPath } });
      }
      rows.push({
        downloadId: u.id,
        innerPath: f.innerPath,
        fileName: r.fileName,
        status: r.status === 'SAVED' ? 'SUCCESS' : 'SKIPPED',
        reason: r.status === 'SKIPPED' ? r.reason : null,
        destinationPath: r.path,
        sha256: r.sha256,
        bytes: BigInt(r.bytes),
      });
    }
    for (const s of extracted.skipped) rows.push({ downloadId: u.id, innerPath: s.innerPath, status: 'SKIPPED', reason: s.reason });
    if (rows.length) await prisma.extractedFile.createMany({ data: rows });

    // 4. Optionally keep the ZIP / email itself.
    let kept: Awaited<ReturnType<typeof saveAttachment>> | null = null;
    if (u.filter.keepContainer) {
      kept = await saveAttachment({ ...u.saveOpts, source: createReadStream(containerPath), fileName: u.fileName });
      if (kept.status === 'SAVED') await u.onSaved({ name: kept.fileName, path: kept.path, sizeBytes: kept.bytes, sha256: kept.sha256 });
    }

    const what = u.kind === 'zip' ? 'ZIP' : 'attached email';
    const summary = `${saved} file(s) saved from ${what}${extracted.skipped.length ? `, ${extracted.skipped.length} skipped` : ''}`;
    const ok = saved > 0 || kept?.status === 'SAVED';
    await prisma.attachmentDownload.update({
      where: { id: u.id },
      data: {
        status: ok ? 'SUCCESS' : 'SKIPPED',
        skipReason: ok ? null : extracted.files.length ? 'Files inside were already saved (duplicates)' : `Nothing inside the ${what} matched the rule`,
        destinationPath: kept?.path ?? (saved ? folder : null),
        finalFileName: kept?.fileName ?? u.original,
        sha256: kept?.sha256 ?? null,
        bytesWritten: BigInt(bytes),
        downloadedAt: ok ? u.ctx.now() : null,
        attempts: u.attempt,
        errorCode: null,
        errorMessage: null,
        nextAttemptAt: null,
      },
    });
    await plog('info', 'download', `${u.original}: ${summary}`, { correlationId: u.correlationId, mailboxId: u.mailboxId });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
