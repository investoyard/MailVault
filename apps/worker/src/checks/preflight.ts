// Go-live readiness check: runs every check an admin would otherwise do by hand.
// Usage: npm run preflight            (exit code 1 if anything blocks go-live)
//        npm run preflight -- --graph (also tests Microsoft 365 access to every enabled mailbox)
import { ROOT } from '../env.js';
import { execSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkFolder } from '@mailvault/core/node';
import { prisma, smtpSettings } from '@mailvault/db';
import { M365Provider, graphConfigFromEnv } from '@mailvault/m365';

type Level = 'ok' | 'warn' | 'fail';
const results: { level: Level; area: string; text: string }[] = [];
const add = (level: Level, area: string, text: string) => results.push({ level, area, text });
const env = (k: string) => process.env[k]?.trim() ?? '';

async function main() {
  // Runtime
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 24 ? 'ok' : 'fail', 'Runtime', `Node.js ${process.versions.node}${major >= 24 ? '' : ' (24 or newer required)'}`);

  // Configuration
  if (!existsSync(resolve(ROOT, '.env'))) add('fail', 'Config', '.env is missing (copy .env.example)');
  add(env('JWT_SECRET').length >= 32 ? 'ok' : 'fail', 'Config', 'JWT_SECRET set (32+ characters)');
  add(env('SECRET_ENC_KEY') ? 'ok' : 'fail', 'Config', 'SECRET_ENC_KEY set');
  const appUrl = env('APP_URL');
  add(appUrl ? 'ok' : 'warn', 'Config', appUrl ? `APP_URL = ${appUrl}` : 'APP_URL not set (alert emails will have no links)');
  if (appUrl.startsWith('https://')) add(env('COOKIE_SECURE') === 'true' ? 'ok' : 'fail', 'Security', 'COOKIE_SECURE=true for HTTPS');
  else add('warn', 'Security', 'Not served over HTTPS yet (run scripts\\setup-iis.ps1 with a certificate, then set COOKIE_SECURE=true)');
  if (env('DEV_ADMIN_PASSWORD')) add('warn', 'Security', 'DEV_ADMIN_PASSWORD is still in .env: change the admin password and remove that line');

  // Database
  try {
    await prisma.$queryRaw`SELECT 1`;
    add('ok', 'Database', 'PostgreSQL reachable');
    const tz = (await prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`)[0]?.tz ?? 'unknown';
    add(tz === 'UTC' || tz === 'Etc/UTC' ? 'ok' : 'fail', 'Database', `Session time zone is ${tz}${tz === 'UTC' ? '' : ' (must be UTC: ALTER DATABASE mailvault SET timezone TO \'UTC\')'}`);
    const applied = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
    const onDisk = readdirSync(resolve(ROOT, 'packages/db/prisma/migrations'), { withFileTypes: true }).filter((d) => d.isDirectory()).length;
    add(Number(applied[0]!.n) === onDisk ? 'ok' : 'fail', 'Database', `Migrations applied ${applied[0]!.n}/${onDisk}${Number(applied[0]!.n) === onDisk ? '' : ' (run: npm run db:deploy)'}`);
    const settings = await prisma.setting.count();
    add(settings >= 16 ? 'ok' : 'fail', 'Database', `Settings present (${settings})${settings >= 16 ? '' : ' (run: npm run db:seed)'}`);
  } catch (err) {
    add('fail', 'Database', `Cannot connect: ${(err as Error).message.split('\n')[0]}`);
    return;
  }

  // Users
  const supers = await prisma.user.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
  add(supers >= 1 ? 'ok' : 'fail', 'Users', `${supers} active Super Admin(s)`);
  if (supers === 1) add('warn', 'Users', 'Only one Super Admin: add a second one so you are not locked out if that person is away');
  const noEmail = await prisma.user.count({ where: { isActive: true, role: { in: ['SUPER_ADMIN', 'ADMIN'] }, email: null } });
  if (noEmail) add('warn', 'Users', `${noEmail} admin(s) without an email address will not receive alert emails`);

  // Demo data
  const demo = await prisma.mailbox.count({ where: { email: { endsWith: '@demo.mailvault.local' } } });
  add(demo ? 'fail' : 'ok', 'Data', demo ? `Demo data present (${demo} demo mailboxes): run npm run db:seed-demo -- --clear` : 'No demo data');

  // Microsoft 365
  const graphOn = Boolean(env('M365_TENANT_ID') && env('M365_CLIENT_ID') && (env('M365_CERT_PATH') || env('M365_CLIENT_SECRET')));
  add(graphOn ? 'ok' : 'fail', 'Microsoft 365', graphOn ? 'App registration configured' : 'M365_TENANT_ID / M365_CLIENT_ID / M365_CERT_PATH not set (docs/ENTRA-SETUP.md)');
  if (env('M365_CLIENT_SECRET') && !env('M365_CERT_PATH')) add('warn', 'Microsoft 365', 'Using a client secret: switch to a certificate before go-live');
  if (env('M365_CERT_PATH')) {
    try {
      const pem = readFileSync(env('M365_CERT_PATH'), 'utf8');
      const block = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem)?.[0];
      if (!block || !/PRIVATE KEY-----/.test(pem)) throw new Error('PEM must contain the certificate and its private key');
      const days = Math.floor((new Date(new X509Certificate(block).validTo).getTime() - Date.now()) / 86_400_000);
      add(days > 30 ? 'ok' : days > 0 ? 'warn' : 'fail', 'Microsoft 365', `Certificate valid for ${days} more day(s)`);
    } catch (err) {
      add('fail', 'Microsoft 365', `Certificate: ${(err as Error).message}`);
    }
  }
  const mailboxes = await prisma.mailbox.findMany({ where: { enabled: true } });
  add(mailboxes.length ? 'ok' : 'warn', 'Mailboxes', `${mailboxes.length} enabled mailbox(es)`);
  if (graphOn && process.argv.includes('--graph')) {
    const provider = new M365Provider(graphConfigFromEnv());
    for (const m of mailboxes) {
      const r = await provider.testConnection(m.email);
      add(r.ok ? 'ok' : 'fail', 'Mailboxes', `${m.email}: ${r.ok ? `connected (${r.latencyMs} ms)` : r.error}`);
    }
  }
  const noRules = await prisma.mailbox.count({ where: { enabled: true, rules: { none: { enabled: true } } } });
  if (noRules) add('warn', 'Rules', `${noRules} enabled mailbox(es) have no enabled rule`);

  // Destinations (checked as the account running this command)
  const dests = await prisma.destination.findMany();
  if (!dests.length) add('warn', 'Folders', 'No destination folders configured');
  for (const d of dests) {
    const r = await checkFolder(d.basePath, d.createIfMissing, d.lowSpaceThresholdMb);
    add(r.status === 'HEALTHY' ? 'ok' : r.status === 'LOW_SPACE' ? 'warn' : 'fail', 'Folders', `${d.name} (${d.basePath}): ${r.status === 'UNAVAILABLE' ? r.error : `${r.status.toLowerCase().replace('_', ' ')}, ${r.freeMb} MB free`}`);
  }
  if (dests.some((d) => d.basePath.startsWith('\\\\'))) add('warn', 'Folders', 'Share checks ran as the current user; the Worker task must run as an account with the same rights');

  // Services
  const beat = await prisma.serviceHeartbeat.findFirst({ where: { service: 'worker' }, orderBy: { lastBeatAt: 'desc' } });
  const online = !!beat && Date.now() - beat.lastBeatAt.getTime() < 180_000;
  add(online ? 'ok' : 'fail', 'Services', online ? `Worker running on ${beat!.hostname}` : 'Worker is not running (scripts\\install-service.ps1)');
  add(existsSync(resolve(ROOT, 'apps/web/dist/index.html')) ? 'ok' : 'fail', 'Services', 'Admin panel built (apps/web/dist)');
  const task = (name: string) => {
    try {
      execSync(`schtasks /Query /TN "${name}"`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  for (const name of ['MailVault-API', 'MailVault-Worker']) {
    const has = task(name);
    add(has ? 'ok' : 'warn', 'Services', has ? `Background task ${name} registered` : `Background task ${name} not registered yet (scripts\\install-service.ps1)`);
  }
  const backup = task('MailVault-Backup');
  add(backup ? 'ok' : 'fail', 'Backup', backup ? 'Nightly database backup task registered' : 'No nightly database backup task (scripts\\install-backup.ps1)');

  // Alerts
  const smtp = await smtpSettings();
  add(smtp.enabled && smtp.host ? 'ok' : 'warn', 'Alerts', smtp.enabled ? `Email alerts via ${smtp.host}` : 'Email alerts are off (Settings → Email alerts)');
  if (smtp.enabled && smtp.user && !env('SMTP_PASSWORD')) add('fail', 'Alerts', 'SMTP username set but SMTP_PASSWORD missing in .env');
}

main()
  .catch((err) => add('fail', 'Preflight', (err as Error).message))
  .finally(async () => {
    await prisma.$disconnect();
    const icon = { ok: '✔', warn: '!', fail: '✘' } as const;
    let area = '';
    for (const r of results) {
      if (r.area !== area) {
        area = r.area;
        console.log(`\n${area}`);
      }
      console.log(`  ${icon[r.level]} ${r.text}`);
    }
    const fails = results.filter((r) => r.level === 'fail').length;
    const warns = results.filter((r) => r.level === 'warn').length;
    console.log(`\n${fails ? `✘ ${fails} blocker(s)` : '✔ No blockers'}, ${warns} warning(s).`);
    process.exit(fails ? 1 : 0);
  });
