// Operational helpers shared by the API and the worker: alerts, processing log, live-update signal,
// and delivery of notifications by email (SMTP) and Microsoft Teams.
import nodemailer from 'nodemailer';
import { prisma } from './index.js';

type Severity = 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
const RANK: Record<Severity, number> = { INFO: 0, SUCCESS: 0, WARNING: 1, ERROR: 2 };

async function adminRecipients() {
  const users = await prisma.user.findMany({ where: { isActive: true, role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, select: { id: true } });
  return { create: users.map((u) => ({ userId: u.id })) };
}

/** Raises an alert once per key until it is resolved (no repeated notifications for the same problem). */
export async function raiseAlert(o: { key: string; type: string; severity: 'WARNING' | 'ERROR'; title: string; message: string; link?: string }) {
  const open = await prisma.notification.findFirst({ where: { alertKey: o.key, resolvedAt: null } });
  if (open) return false;
  await prisma.notification.create({
    data: { type: o.type, severity: o.severity, title: o.title, message: o.message, alertKey: o.key, link: o.link, recipients: await adminRecipients() },
  });
  await notifyChange('notification');
  return true;
}

/** Closes an open alert and tells admins it recovered. */
export async function resolveAlert(key: string, title: string, message: string, link?: string) {
  const { count } = await prisma.notification.updateMany({ where: { alertKey: key, resolvedAt: null }, data: { resolvedAt: new Date() } });
  if (count === 0) return false;
  await prisma.notification.create({ data: { type: 'RESOLVED', severity: 'SUCCESS', title, message, link, recipients: await adminRecipients() } });
  await notifyChange('notification');
  return true;
}

export async function plog(level: 'info' | 'warn' | 'error', source: string, message: string, extra: { correlationId?: string; mailboxId?: string; data?: unknown } = {}) {
  await prisma.processingLog
    .create({ data: { level, source, message, correlationId: extra.correlationId, mailboxId: extra.mailboxId, data: extra.data as never } })
    .catch(() => undefined);
}

/** Tells the API (Postgres LISTEN/NOTIFY) that data changed, so open screens refresh live. */
export async function notifyChange(kind: string) {
  await prisma.$executeRaw`SELECT pg_notify('mailvault_events', ${JSON.stringify({ kind, at: Date.now() })})`.catch(() => undefined);
}

// ───────────────────────── Delivery ─────────────────────────

export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
}

export interface UserPrefs {
  email: boolean;
  digest: 'instant' | 'daily' | 'off';
  minSeverity: 'INFO' | 'WARNING' | 'ERROR';
}

export const DEFAULT_PREFS: UserPrefs = { email: true, digest: 'instant', minSeverity: 'WARNING' };

async function setting<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return (row?.value as T | undefined) ?? fallback;
}

export async function smtpSettings(): Promise<SmtpSettings> {
  return setting<SmtpSettings>('notifications.smtp', { enabled: false, host: '', port: 587, secure: false, user: '', from: '' });
}

/** Test seam: tests replace the transport factory. */
export const delivery = {
  createTransport: (s: SmtpSettings) =>
    nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      auth: s.user ? { user: s.user, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
      connectionTimeout: 15_000,
    }),
  postTeams: async (url: string, body: unknown) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Teams webhook returned ${res.status}`);
  },
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const COLORS: Record<Severity, string> = { ERROR: '#DC2626', WARNING: '#D97706', SUCCESS: '#16A34A', INFO: '#0284C7' };

function appUrl(link?: string | null) {
  const base = (process.env.APP_URL ?? '').replace(/\/$/, '');
  return base && link ? `${base}${link}` : base || null;
}

export function renderEmail(items: { title: string; message: string; severity: Severity; link?: string | null; createdAt: Date }[], heading: string): { subject: string; html: string; text: string } {
  const rows = items
    .map((n) => {
      const url = appUrl(n.link);
      return `<tr><td style="padding:12px 16px;border-bottom:1px solid #eef1f6">
        <div style="font-weight:600;color:${COLORS[n.severity]}">${esc(n.title)}</div>
        <div style="color:#334155;margin-top:4px">${esc(n.message)}</div>
        ${url ? `<a href="${esc(url)}" style="color:#3C2E7E;font-size:13px">Open in MailVault</a>` : ''}
      </td></tr>`;
    })
    .join('');
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;background:#f5f7fb;padding:24px">
    <table style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e6e9f0;border-radius:12px;border-collapse:separate;overflow:hidden" width="100%" cellspacing="0">
      <tr><td style="background:#3C2E7E;color:#fff;padding:16px 20px;font-size:17px;font-weight:700">MailVault · ${esc(heading)}</td></tr>
      ${rows}
      <tr><td style="padding:12px 16px;color:#94a3b8;font-size:12px">Change what you receive under your name → My notification preferences.</td></tr>
    </table></div>`;
  const text = items.map((n) => `[${n.severity}] ${n.title}\n${n.message}${appUrl(n.link) ? `\n${appUrl(n.link)}` : ''}`).join('\n\n');
  const subject = items.length === 1 ? `MailVault: ${items[0]!.title}` : `MailVault: ${heading}`;
  return { subject, html, text };
}

/**
 * Sends notifications that have not been delivered yet. Safe to call from several processes:
 * each notification is claimed atomically. Returns the number of emails sent.
 */
export async function dispatchPending(): Promise<number> {
  const claimed = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "Notification" SET "dispatchedAt" = ${new Date()}
    WHERE id IN (SELECT id FROM "Notification" WHERE "dispatchedAt" IS NULL ORDER BY "createdAt" LIMIT 100 FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  if (!claimed.length) return 0;

  const notes = await prisma.notification.findMany({
    where: { id: { in: claimed.map((c) => c.id) } },
    include: { recipients: { include: { user: { select: { email: true, isActive: true, notificationPrefs: true } } } } },
    orderBy: { createdAt: 'asc' },
  });

  // Teams: one card per warning/error (resolutions included so the channel sees recoveries).
  const teamsUrl = process.env.TEAMS_WEBHOOK_URL?.trim();
  if (teamsUrl && (await setting('notifications.teams.enabled', false))) {
    for (const n of notes.filter((x) => RANK[x.severity as Severity] >= 1 || x.type === 'RESOLVED')) {
      await delivery
        .postTeams(teamsUrl, {
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                type: 'AdaptiveCard',
                version: '1.4',
                body: [
                  { type: 'TextBlock', text: n.title, weight: 'Bolder', size: 'Medium', color: n.severity === 'ERROR' ? 'Attention' : n.severity === 'WARNING' ? 'Warning' : 'Good', wrap: true },
                  { type: 'TextBlock', text: n.message, wrap: true },
                ],
                actions: appUrl(n.link) ? [{ type: 'Action.OpenUrl', title: 'Open in MailVault', url: appUrl(n.link) }] : [],
              },
            },
          ],
        })
        .catch((err: Error) => plog('warn', 'notify', `Teams delivery failed: ${err.message}`));
    }
  }

  // Email: instant subscribers only (daily subscribers get the digest).
  const smtp = await smtpSettings();
  if (!smtp.enabled || !smtp.host || !smtp.from) return 0;
  const perUser = new Map<string, typeof notes>();
  for (const n of notes) {
    for (const r of n.recipients) {
      const prefs = { ...DEFAULT_PREFS, ...((r.user.notificationPrefs as Partial<UserPrefs> | null) ?? {}) };
      if (!r.user.isActive || !r.user.email || !prefs.email || prefs.digest !== 'instant') continue;
      if (RANK[n.severity as Severity] < RANK[prefs.minSeverity] && n.type !== 'RESOLVED') continue;
      if (n.type === 'RESOLVED' && prefs.minSeverity === 'ERROR') continue;
      perUser.set(r.user.email, [...(perUser.get(r.user.email) ?? []), n]);
    }
  }
  if (!perUser.size) return 0;
  const transport = delivery.createTransport(smtp);
  let sent = 0;
  for (const [to, items] of perUser) {
    const mail = renderEmail(items.map((n) => ({ ...n, severity: n.severity as Severity })), `${items.length} new alert${items.length > 1 ? 's' : ''}`);
    try {
      await transport.sendMail({ from: smtp.from, to, subject: mail.subject, html: mail.html, text: mail.text });
      sent++;
    } catch (err) {
      await plog('warn', 'notify', `Email to ${to} failed: ${(err as Error).message}`);
    }
  }
  return sent;
}

/** Daily summary for users who chose "once a day": yesterday's alerts plus processing totals. */
export async function sendDailyDigest(now = new Date()): Promise<number> {
  const smtp = await smtpSettings();
  if (!smtp.enabled || !smtp.host || !smtp.from) return 0;
  const since = new Date(now.getTime() - 24 * 3600_000);
  const users = await prisma.user.findMany({ where: { isActive: true, email: { not: null } } });
  const [success, failed, skipped] = await Promise.all(
    (['SUCCESS', 'FAILED', 'SKIPPED'] as const).map((status) => prisma.attachmentDownload.count({ where: { status, updatedAt: { gte: since } } })),
  );
  const summary = { title: 'Last 24 hours', message: `${success} attachment(s) saved, ${failed} failed, ${skipped} skipped.`, severity: (failed ? 'WARNING' : 'SUCCESS') as Severity, link: '/history', createdAt: now };
  const transport = delivery.createTransport(smtp);
  let sent = 0;
  for (const u of users) {
    const prefs = { ...DEFAULT_PREFS, ...((u.notificationPrefs as Partial<UserPrefs> | null) ?? {}) };
    if (!prefs.email || prefs.digest !== 'daily') continue;
    const notes = await prisma.notification.findMany({
      where: { createdAt: { gte: since }, recipients: { some: { userId: u.id } } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    const items = notes.filter((n) => RANK[n.severity as Severity] >= RANK[prefs.minSeverity]).map((n) => ({ ...n, severity: n.severity as Severity }));
    const mail = renderEmail([summary, ...items], 'Daily summary');
    try {
      await transport.sendMail({ from: smtp.from, to: u.email!, subject: mail.subject, html: mail.html, text: mail.text });
      sent++;
    } catch (err) {
      await plog('warn', 'notify', `Daily summary to ${u.email} failed: ${(err as Error).message}`);
    }
  }
  return sent;
}

/** Sends one test email with the given settings (used by the Settings page). */
export async function sendTestEmail(s: SmtpSettings, to: string) {
  const mail = renderEmail([{ title: 'Test email', message: 'Email alerts from MailVault are working.', severity: 'SUCCESS', createdAt: new Date() }], 'Test');
  await delivery.createTransport(s).sendMail({ from: s.from, to, subject: mail.subject, html: mail.html, text: mail.text });
}
