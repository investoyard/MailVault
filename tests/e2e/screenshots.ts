// Takes screenshots of every admin page using the Microsoft Edge installed on this server.
// Usage: npx tsx tests/e2e/screenshots.ts [outDir]   (needs API + web dev servers running)
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = process.env.MV_URL ?? 'http://localhost:5180';
const out = resolve(process.argv[2] ?? 'logs/screenshots');
mkdirSync(out, { recursive: true });

const env = Object.fromEntries(
  readFileSync(resolve('.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const pages = [
  ['dashboard', '/'],
  ['accounts', '/accounts'],
  ['rules', '/rules'],
  ['history', '/history'],
  ['destinations', '/destinations'],
  ['notifications', '/notifications'],
  ['logs', '/logs'],
  ['system', '/system'],
  ['users', '/users'],
  ['settings', '/settings'],
  ['rule-testing', '/rule-testing'],
  ['historical-jobs', '/historical-jobs'],
] as const;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1536, height: 960 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

await page.goto(base);
await page.waitForSelector('text=Sign in');
await page.screenshot({ path: resolve(out, '00-login.png') });

await page.fill('#username', env.DEV_ADMIN_USER ?? 'admin');
await page.fill('#password', env.DEV_ADMIN_PASSWORD ?? '');
await page.click('button[type=submit]');
await page.waitForSelector('text=Dashboard');

for (const [i, [name, path]] of pages.entries()) {
  await page.goto(base + path);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(700);
  await page.screenshot({ path: resolve(out, `${String(i + 1).padStart(2, '0')}-${name}.png`), fullPage: true });
}

// History detail drawer
await page.goto(base + '/history');
await page.waitForLoadState('networkidle');
await page.locator('.ant-table-row').first().click();
await page.waitForTimeout(600);
await page.screenshot({ path: resolve(out, '20-history-drawer.png') });

// Rule editor (edit an existing rule, then a new one)
await page.goto(base + '/rules');
await page.waitForLoadState('networkidle');
await page.getByRole('button', { name: 'Edit' }).first().click();
await page.waitForSelector('text=Example save location');
await page.waitForTimeout(800);
await page.screenshot({ path: resolve(out, '21-rule-editor-edit.png') });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'New rule' }).click();
await page.waitForSelector('text=Example save location');
await page.waitForTimeout(800);
await page.screenshot({ path: resolve(out, '22-rule-editor-new.png'), fullPage: false });

// Accounts: more-actions menu + folders dialog
await page.goto(base + '/accounts');
await page.waitForLoadState('networkidle');
await page.getByRole('button', { name: 'More actions' }).first().click();
await page.getByText('Monitored folders').click();
await page.waitForTimeout(1000);
await page.screenshot({ path: resolve(out, '23-accounts-folders.png') });

// Historical job drawer
await page.goto(base + '/historical-jobs');
await page.waitForLoadState('networkidle');
await page.getByRole('button', { name: 'New historical job' }).first().click();
await page.waitForTimeout(800);
await page.screenshot({ path: resolve(out, '24-historical-new.png') });

// Users: edit drawer with permissions
await page.goto(base + '/users');
await page.waitForLoadState('networkidle');
await page.getByRole('button', { name: 'Add user' }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: resolve(out, '26-user-drawer.png') });
await page.keyboard.press('Escape');

// History: row selection for bulk retry + email details
await page.goto(base + '/history?status=FAILED');
await page.waitForLoadState('networkidle');
await page.locator('.ant-table-row .ant-checkbox-input').first().check().catch(() => undefined);
await page.waitForTimeout(400);
await page.screenshot({ path: resolve(out, '25-history-bulk.png') });

await browser.close();
console.log(`Saved screenshots to ${out}`);
if (errors.length) {
  console.log('Browser errors:');
  for (const e of [...new Set(errors)]) console.log(' -', e);
}
