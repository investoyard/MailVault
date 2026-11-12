// Layout check: no page may scroll sideways at common screen widths (tables scroll inside their card instead).
// Usage: npx tsx tests/e2e/overflow.ts        (needs api + web running)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const base = process.env.MV_URL ?? 'http://localhost:5180';
const pw = /DEV_ADMIN_PASSWORD=(.*)/.exec(readFileSync(resolve('.env'), 'utf8'))?.[1]?.trim() ?? '';
const PAGES = ['/', '/accounts', '/rules', '/rule-testing', '/historical-jobs', '/history', '/destinations', '/notifications', '/logs', '/system', '/users', '/integrations', '/settings'];
const WIDTHS = [1280, 1366, 1440, 1536, 1920];

async function measure(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const over = doc.scrollWidth - doc.clientWidth;
    // The widest elements sticking out past the viewport (to find the culprit)
    const vw = doc.clientWidth;
    const culprits = [...document.querySelectorAll('body *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.right > vw + 1 && r.width > 0)
      .sort((a, b) => b.r.right - a.r.right)
      .slice(0, 3)
      .map(({ el, r }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).split(' ').slice(0, 2).join('.')} →${Math.round(r.right)}`);
    // Tables that need their own (in-card) scrollbar: allowed, but reported so we can keep them rare.
    const inner = [...document.querySelectorAll('.ant-table-content')].filter((el) => el.scrollWidth > el.clientWidth + 1).length;
    return { over, culprits, inner };
  });
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
let failures = 0;
for (const collapsed of [false, true]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(base);
  await page.evaluate((c) => localStorage.setItem('mv.sidebarCollapsed', c ? '1' : '0'), collapsed);
  await page.fill('#username', 'admin');
  await page.fill('#password', pw);
  await page.click('button[type=submit]');
  await page.waitForSelector('.mv-nav');
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of PAGES) {
      await page.goto(base + path);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(350);
      const m = await measure(page);
      if (m.over > 0) {
        failures++;
        console.log(`✘ ${width}px ${collapsed ? 'collapsed' : 'expanded'} ${path}: page is ${m.over}px too wide · ${m.culprits.join(' | ')}`);
      } else if (m.inner > 0) {
        console.log(`· ${width}px ${collapsed ? 'collapsed' : 'expanded'} ${path}: table scrolls inside its card`);
      }
    }
  }
  await page.evaluate(() => localStorage.removeItem('mv.sidebarCollapsed'));
  await ctx.close();
}
await browser.close();
console.log(failures ? `\n${failures} page/width combination(s) scroll sideways` : `\n✔ No horizontal page scroll on ${PAGES.length} pages × ${WIDTHS.length} widths × sidebar expanded/collapsed`);
process.exit(failures ? 1 : 0);
