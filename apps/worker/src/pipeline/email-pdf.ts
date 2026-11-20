// Renders an email to PDF with the installed Microsoft Edge (headless, via playwright-core).
// One browser is shared and reused; at most 2 emails render at once; it closes after 5 idle minutes.
// JavaScript is off and every network request is blocked (except internet pictures when the rule allows them).
import { chromium, type Browser } from 'playwright-core';
import { buildEmailHtml, escapeHtml, type EmailContent } from '@mailvault/core';
import { log } from '../env.js';

const MAX_PARALLEL = 2;
const IDLE_CLOSE_MS = 5 * 60_000;

let browser: Promise<Browser> | null = null;
let active = 0;
const waiting: (() => void)[] = [];
let idleTimer: NodeJS.Timeout | undefined;

function getBrowser(): Promise<Browser> {
  if (!browser) {
    const launching = chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-extensions', '--disable-gpu'] }).then((b) => {
      b.on('disconnected', () => {
        if (browser === launching) browser = null;
      });
      return b;
    });
    launching.catch(() => {
      if (browser === launching) browser = null;
    });
    browser = launching;
  }
  return browser;
}

async function acquire() {
  clearTimeout(idleTimer);
  if (active < MAX_PARALLEL) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) return next(); // hand the slot over
  active--;
  if (active === 0) {
    idleTimer = setTimeout(() => void closeEmailPdfBrowser(), IDLE_CLOSE_MS);
    idleTimer.unref();
  }
}

export async function closeEmailPdfBrowser() {
  const b = browser;
  browser = null;
  if (b) await b.then((x) => x.close()).catch(() => undefined);
}

/** Explains a renderer failure in words an admin can act on. */
export class EmailPdfError extends Error {
  code = 'EMAIL_PDF_FAILED';
}

export async function renderEmailPdf(email: EmailContent, outPath: string, o: { timeZone: string; allowRemoteImages: boolean; footer: string }) {
  const html = buildEmailHtml(email, { timeZone: o.timeZone, allowRemoteImages: o.allowRemoteImages });
  await acquire();
  try {
    let b: Browser;
    try {
      b = await getBrowser();
    } catch (err) {
      throw new EmailPdfError(`Microsoft Edge could not be started to create the email PDF: ${(err as Error).message.split('\n')[0]}`);
    }
    const context = await b.newContext({ javaScriptEnabled: false, offline: !o.allowRemoteImages });
    try {
      await context.route('**/*', (route) => {
        const req = route.request();
        if (o.allowRemoteImages && req.resourceType() === 'image' && /^https?:/i.test(req.url())) return route.continue();
        return route.abort();
      });
      const page = await context.newPage();
      try {
        await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
      } catch (err) {
        // Slow internet pictures: print what has loaded instead of failing the whole email.
        if (!/Timeout/i.test((err as Error).message)) throw err;
        log.warn({ outPath }, 'email PDF: page load timed out, printing anyway');
      }
      await page.pdf({
        path: outPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: `<div style="font-family:'Segoe UI',Arial,sans-serif;font-size:7.5px;color:#64748b;width:100%;padding:0 12mm;display:flex;justify-content:space-between;gap:12px"><span style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escapeHtml(o.footer)}</span><span style="white-space:nowrap">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
      });
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    release();
  }
}
