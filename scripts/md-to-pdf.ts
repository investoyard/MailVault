// Converts a Markdown doc to a styled A4 PDF using the installed Microsoft Edge.
// Usage: npx tsx scripts/md-to-pdf.ts docs/ENTRA-SETUP.md [out.pdf]
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { marked } from 'marked';
import { chromium } from 'playwright-core';

const input = process.argv[2];
if (!input) {
  console.error('Usage: npx tsx scripts/md-to-pdf.ts <file.md> [out.pdf]');
  process.exit(1);
}
const output = resolve(process.argv[3] ?? input.replace(/\.md$/i, '.pdf'));
const md = readFileSync(input, 'utf8');
const title = /^#\s+(.+)$/m.exec(md)?.[1] ?? basename(input);
const body = await marked.parse(md);
const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Inter, Arial, sans-serif; color: #0f172a; font-size: 10.5pt; line-height: 1.55; }
  .cover { display: flex; align-items: center; gap: 12px; padding-bottom: 14px; margin-bottom: 18px; border-bottom: 3px solid #3C2E7E; }
  .logo { width: 38px; height: 38px; border-radius: 10px; background: linear-gradient(135deg,#5B47B0,#2E2266); color: #fff;
          display: grid; place-items: center; font-weight: 700; font-size: 18px; }
  .brand { font-weight: 700; font-size: 15pt; } .meta { color: #64748b; font-size: 9pt; }
  h1 { font-size: 20pt; margin: 0 0 6px; letter-spacing: -0.3px; }
  h2 { font-size: 13.5pt; color: #241A52; margin: 22px 0 8px; padding-top: 8px; border-top: 1px solid #e6e9f0; page-break-after: avoid; }
  h3 { font-size: 11.5pt; margin: 16px 0 6px; page-break-after: avoid; }
  p { margin: 6px 0; } ul, ol { margin: 6px 0 6px 20px; padding: 0; } li { margin: 3px 0; }
  code { font-family: Consolas, 'Cascadia Mono', monospace; font-size: 9pt; background: #f1f5f9; padding: 1px 4px; border-radius: 4px; }
  pre { background: #0f172a; color: #e2e8f0; padding: 12px 14px; border-radius: 8px; font-size: 8.6pt; line-height: 1.45;
        white-space: pre-wrap; word-break: break-all; page-break-inside: avoid; }
  pre code { background: none; color: inherit; padding: 0; font-size: inherit; }
  blockquote { margin: 10px 0; padding: 8px 12px; background: #EFECF8; border-left: 4px solid #3C2E7E; border-radius: 4px; color: #241A52; }
  blockquote p { margin: 0; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 9.5pt; page-break-inside: avoid; }
  th, td { border: 1px solid #e2e8f0; padding: 7px 9px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; font-weight: 600; }
  hr { border: none; border-top: 1px solid #e6e9f0; margin: 18px 0; }
  strong { font-weight: 650; }
</style></head><body>
<div class="cover"><div class="logo">M</div><div><div class="brand">MailVault</div><div class="meta">Documentation · ${today}</div></div></div>
${body}
</body></html>`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
if (process.env.PREVIEW_PNG) {
  await page.setViewportSize({ width: 794, height: 1123 }); // A4 at 96 dpi
  await page.screenshot({ path: process.env.PREVIEW_PNG, fullPage: true });
}
await page.pdf({
  path: output,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate: `<div style="width:100%;font-size:8px;color:#94a3b8;padding:0 16mm;display:flex;justify-content:space-between;font-family:Segoe UI,Arial">
    <span>MailVault · ${title}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
  margin: { top: '18mm', bottom: '20mm', left: '16mm', right: '16mm' },
});
await browser.close();
console.log(`Saved ${output}`);
