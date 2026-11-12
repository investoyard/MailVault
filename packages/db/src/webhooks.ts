// Outbound webhooks: queue an event for every matching webhook, then deliver with signing and retries.
import { createHmac, randomBytes } from 'node:crypto';
import { prisma } from './index.js';
import { plog, raiseAlert, resolveAlert } from './ops.js';
import { decryptSecret } from './secrets.js';

export const WEBHOOK_EVENTS = ['file.saved', 'file.failed', 'job.completed'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const RETRY_MINUTES = [1, 5, 15, 60, 240];
const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

/** Signature header value: HMAC-SHA256 over "<timestamp>.<body>" with the webhook secret. */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Creates one pending delivery per enabled webhook that subscribes to this event (and matches its filters). */
export async function emitWebhookEvent(event: WebhookEvent, data: Record<string, unknown>, scope: { mailboxId?: string; ruleId?: string } = {}) {
  const hooks = await prisma.webhook.findMany({ where: { enabled: true, events: { has: event } } });
  const matching = hooks.filter(
    (h) => (!h.mailboxIds.length || (scope.mailboxId && h.mailboxIds.includes(scope.mailboxId))) && (!h.ruleIds.length || (scope.ruleId && h.ruleIds.includes(scope.ruleId))),
  );
  if (!matching.length) return 0;
  await prisma.webhookDelivery.createMany({
    data: matching.map((h) => ({ webhookId: h.id, event, payload: { event, occurredAt: new Date().toISOString(), data } as never })),
  });
  return matching.length;
}

/** Test seam for integration tests. */
export const webhookTransport = {
  post: async (url: string, body: string, headers: Record<string, string>) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(url, { method: 'POST', body, headers, signal: ctrl.signal, redirect: 'manual' });
      const text = (await res.text().catch(() => '')).slice(0, 300);
      return { status: res.status, text };
    } finally {
      clearTimeout(t);
    }
  },
};

/** Sends one delivery now. Returns the HTTP status (0 = network error). */
export async function deliverOne(deliveryId: string): Promise<{ ok: boolean; status: number; error?: string }> {
  const d = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { webhook: true } });
  const body = JSON.stringify({ id: d.id, ...(d.payload as object) });
  const ts = Math.floor(Date.now() / 1000).toString();
  let status = 0;
  let error: string | undefined;
  try {
    const secret = decryptSecret(d.webhook.secretEnc);
    const res = await webhookTransport.post(d.webhook.url, body, {
      'Content-Type': 'application/json',
      'User-Agent': 'MailVault-Webhook/1.0',
      'X-MailVault-Event': d.event,
      'X-MailVault-Delivery': d.id,
      'X-MailVault-Timestamp': ts,
      'X-MailVault-Signature': signPayload(secret, ts, body),
    });
    status = res.status;
    if (status < 200 || status >= 300) error = `HTTP ${status}${res.text ? `: ${res.text}` : ''}`;
  } catch (err) {
    error = (err as Error).name === 'AbortError' ? 'No response within 10 seconds' : (err as Error).message;
  }
  const ok = !error;
  const attempts = d.attempts + 1;
  const giveUp = !ok && attempts >= MAX_ATTEMPTS;
  await prisma.webhookDelivery.update({
    where: { id: d.id },
    data: ok
      ? { status: 'SUCCESS', attempts, responseCode: status, error: null, deliveredAt: new Date(), nextAttemptAt: null }
      : {
          status: giveUp ? 'FAILED' : 'RETRYING',
          attempts,
          responseCode: status || null,
          error,
          nextAttemptAt: giveUp ? null : new Date(Date.now() + RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)]! * 60_000),
        },
  });
  await prisma.webhook.update({ where: { id: d.webhookId }, data: { lastStatus: status || null, lastError: error ?? null, ...(ok ? { lastDeliveredAt: new Date() } : {}) } });
  const key = `WEBHOOK:${d.webhookId}`;
  if (giveUp) {
    await raiseAlert({ key, type: 'WEBHOOK_FAILED', severity: 'ERROR', title: `Integration not receiving events: ${d.webhook.name}`, message: `${d.webhook.url} failed ${attempts} times: ${error}`, link: '/integrations' });
    await plog('error', 'webhook', `${d.webhook.name}: delivery ${d.id} (${d.event}) failed permanently: ${error}`);
  } else if (ok) {
    await resolveAlert(key, `Integration receiving events again: ${d.webhook.name}`, d.webhook.url, '/integrations');
  }
  return { ok, status, error };
}

/** Delivers everything due (safe from several processes: rows are claimed atomically). */
export async function dispatchWebhooks(limit = 50): Promise<number> {
  const claimed = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "WebhookDelivery" SET status = 'SENDING'
    WHERE id IN (
      SELECT id FROM "WebhookDelivery"
      WHERE status IN ('PENDING', 'RETRYING') AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${new Date()})
      ORDER BY "createdAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED
    ) RETURNING id`;
  for (const { id } of claimed) await deliverOne(id);
  return claimed.length;
}
