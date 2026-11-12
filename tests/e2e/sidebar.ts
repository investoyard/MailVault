// Sidebar check: accordion (one parent open), auto-open for the current page, collapsed icons with hover pop-out.
// Usage: npx tsx tests/e2e/sidebar.ts [outDir]   (needs api + web running)
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = process.env.MV_URL ?? 'http://localhost:5180';
const out = resolve(process.argv[2] ?? 'logs/sidebar');
mkdirSync(out, { recursive: true });
const pw = /DEV_ADMIN_PASSWORD=(.*)/.exec(readFileSync(resolve('.env'), 'utf8'))?.[1]?.trim() ?? '';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const shot = (name: string) => page.screenshot({ path: resolve(out, `${name}.png`), clip: { x: 0, y: 0, width: 560, height: 900 } });
const openParents = () =>
  page.$$eval('.mv-nav > .ant-menu-submenu-open > .ant-menu-submenu-title', (els) => els.map((e) => e.textContent?.trim()));
const check = (label: string, ok: boolean) => console.log(`${ok ? '✔' : '✘'} ${label}`);

await page.goto(base);
await page.evaluate(() => localStorage.removeItem('mv.sidebarCollapsed'));
await page.fill('#username', 'admin');
await page.fill('#password', pw);
await page.click('button[type=submit]');
await page.waitForSelector('.mv-nav');

// 1. Deep link opens its parent
await page.goto(base + '/history');
await page.waitForSelector('.mv-nav');
await page.waitForTimeout(400);
check(`Opening /history opens only "Records" → ${JSON.stringify(await openParents())}`, JSON.stringify(await openParents()) === '["Records"]');
await shot('1-expanded-records');

// 2. Clicking another parent closes the first (accordion)
await page.click('.mv-nav .ant-menu-submenu-title:has-text("Mail Automation")');
await page.waitForTimeout(400);
check(`Click "Mail Automation" → ${JSON.stringify(await openParents())}`, JSON.stringify(await openParents()) === '["Mail Automation"]');
await shot('2-accordion-mail');

// 3. Clicking the open parent closes it
await page.click('.mv-nav .ant-menu-submenu-title:has-text("Mail Automation")');
await page.waitForTimeout(400);
check(`Click it again closes it → ${JSON.stringify(await openParents())}`, (await openParents()).length === 0);

// 4. Navigate via a child: its parent stays open and the child is highlighted
await page.click('.mv-nav .ant-menu-submenu-title:has-text("Administration")');
await page.waitForTimeout(300);
await page.click('.mv-nav .ant-menu-item:has-text("Users & Roles")');
await page.waitForURL('**/users');
await page.waitForTimeout(400);
const selected = await page.$eval('.mv-nav .ant-menu-item-selected', (e) => e.textContent?.trim());
check(`Child "Users & Roles" selected → ${selected}; open ${JSON.stringify(await openParents())}`, selected === 'Users & Roles' && JSON.stringify(await openParents()) === '["Administration"]');

// 5. Collapse: only parent icons; hover shows the children pop-out
await page.click('button[aria-label="Toggle menu"]');
await page.waitForTimeout(500);
const width = await page.$eval('.mv-sider', (e) => Math.round(e.getBoundingClientRect().width));
check(`Collapsed sidebar width ${width}px`, width === 72);
await shot('3-collapsed');
await page.hover('.mv-nav [data-menu-id$="grp:records"]');
await page.waitForSelector('.mv-menu-popup:not(.ant-menu-submenu-hidden) .ant-menu-item', { timeout: 3000 });
await page.waitForTimeout(400);
const popupItems = await page.$$eval('.mv-menu-popup:not(.ant-menu-submenu-hidden) .ant-menu-item', (els) => els.map((e) => e.textContent?.trim()));
check(`Hover "Records" icon shows pop-out → ${JSON.stringify(popupItems)}`, JSON.stringify(popupItems) === '["Download History","Destination Folders"]');
await page.screenshot({ path: resolve(out, '4-collapsed-hover.png'), clip: { x: 0, y: 0, width: 560, height: 900 } });
await page.click('.mv-menu-popup:not(.ant-menu-submenu-hidden) .ant-menu-item:has-text("Destination Folders")');
await page.waitForURL('**/destinations');
check('Clicking a pop-out item navigates (collapsed)', page.url().endsWith('/destinations'));

// 6. Collapsed state is remembered after reload; expanding opens the current parent again
await page.reload();
await page.waitForSelector('.mv-nav');
await page.waitForTimeout(500);
const widthAfter = await page.$eval('.mv-sider', (e) => Math.round(e.getBoundingClientRect().width));
check(`Still collapsed after reload (${widthAfter}px)`, widthAfter === 72);
await page.click('button[aria-label="Toggle menu"]');
await page.waitForTimeout(500);
check(`Expanded again → open ${JSON.stringify(await openParents())}`, JSON.stringify(await openParents()) === '["Records"]');
await page.evaluate(() => localStorage.removeItem('mv.sidebarCollapsed'));

await browser.close();
console.log(`Screenshots in ${out}`);
