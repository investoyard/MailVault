// Live updates: the worker runs pg_notify('mailvault_events', …); we LISTEN once and fan out to browsers via SSE.
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { requireAuth } from './auth.js';

type Client = { write: (s: string) => void };
const clients = new Set<Client>();
let listener: pg.Client | null = null;

async function startListener(log: FastifyInstance['log']) {
  const c = new pg.Client({ connectionString: (process.env.DATABASE_URL ?? '').replace(/\?.*$/, '') });
  c.on('notification', (n) => {
    for (const cl of clients) cl.write(`event: change\ndata: ${n.payload ?? '{}'}\n\n`);
  });
  c.on('error', (err) => {
    log.warn({ err }, 'event listener lost; reconnecting in 10s');
    listener = null;
    setTimeout(() => void startListener(log).catch(() => undefined), 10_000);
  });
  await c.connect();
  await c.query('LISTEN mailvault_events');
  listener = c;
}

export async function eventRoutes(app: FastifyInstance) {
  await startListener(app.log).catch((err) => app.log.warn({ err }, 'live updates disabled'));

  app.get('/events', { preHandler: requireAuth }, (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const client: Client = { write: (s) => reply.raw.write(s) };
    clients.add(client);
    client.write(`event: ready\ndata: {}\n\n`);
    const ping = setInterval(() => client.write(': ping\n\n'), 25_000); // keeps IIS/proxies from closing it
    req.raw.on('close', () => {
      clearInterval(ping);
      clients.delete(client);
    });
  });

  app.addHook('onClose', async () => {
    await listener?.end().catch(() => undefined);
  });
}
