// Builds the printable HTML for "Save the email as PDF": a header block (From, To, CC, Date, Subject,
// attachments) followed by the email body. Email HTML is untrusted: scripts, frames, forms, links to
// other resources and event handlers are removed, and a Content-Security-Policy allows only pictures
// embedded in the email (plus internet pictures when the rule allows them). The renderer also runs
// with JavaScript off and network blocked, so this is defence in depth.
import type { EmailContent, MailAddress } from './provider.js';
import { formatDate } from './path-pattern.js';

export interface EmailHtmlOptions {
  timeZone: string;
  allowRemoteImages?: boolean;
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmtAddr = (a: MailAddress) => (a.name && a.name.toLowerCase() !== a.email.toLowerCase() ? `${a.name} <${a.email}>` : a.email);
const fmtList = (list: MailAddress[]) => list.filter((a) => a.email).map(fmtAddr).join('; ');

/** Removes active and external content from email HTML; returns { styles, body }. */
export function sanitizeEmailHtml(html: string, images: EmailContent['inlineImages'] = []): { styles: string; body: string } {
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!.replace(/@import[^;]+;?/gi, '')).join('\n');
  let body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html.replace(/<head\b[\s\S]*?<\/head>/i, '');
  body = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|frame|frameset|object|applet|noscript|template|svg|math|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|iframe|frame|frameset|object|embed|applet|link|meta|base|form|input|button|select|textarea|html|head|body|!doctype)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|action|background|poster|xlink:href)\s*=\s*(["']?)\s*(javascript|vbscript|file):[^"'\s>]*\2/gi, '$1=""');

  // Pictures embedded in the email: cid:image001.png@01DA… → data: URI.
  const byId = new Map<string, EmailContent['inlineImages'][number]>();
  for (const img of images) {
    byId.set(img.contentId.toLowerCase(), img);
    byId.set(img.name.toLowerCase(), img);
  }
  body = body.replace(/(src\s*=\s*["']?)cid:([^"'\s>]+)/gi, (whole, pre: string, id: string) => {
    const key = decodeURIComponent(id).toLowerCase();
    const img = byId.get(key) ?? byId.get(key.split('@')[0]!);
    return img ? `${pre}data:${img.contentType};base64,${img.base64}` : whole;
  });
  return { styles, body };
}

export function buildEmailHtml(email: EmailContent, o: EmailHtmlOptions): string {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:${o.allowRemoteImages ? ' https: http:' : ''}`;
  const date = formatDate(email.receivedAt, 'd MMMM yyyy, HH:mm', o.timeZone);
  const rows: [string, string][] = [
    ['From', fmtAddr(email.from)],
    ['To', fmtList(email.to)],
    ['Cc', fmtList(email.cc)],
    ['Date', `${date} (${o.timeZone})`],
    ['Attachments', email.attachmentNames.join(', ')],
  ];
  const header = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><th>${k}</th><td>${escapeHtml(v)}</td></tr>`)
    .join('');

  let styles = '';
  let body: string;
  if (email.body.type === 'html') {
    const s = sanitizeEmailHtml(email.body.content, email.inlineImages);
    styles = s.styles;
    body = `<div class="mv-email-body">${s.body}</div>`;
  } else {
    body = `<div class="mv-email-body mv-text">${escapeHtml(email.body.content)}</div>`;
  }

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(email.subject || '(no subject)')}</title>
<style>
  @page { size: A4; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .mv-head { font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; border-bottom: 2px solid #3C2E7E; padding: 0 0 10px; margin: 0 0 16px; }
  .mv-head h1 { font-size: 16pt; line-height: 1.3; margin: 0 0 8px; font-weight: 600; word-break: break-word; }
  .mv-head table { border-collapse: collapse; font-size: 9.5pt; width: 100% !important; margin: 0; background: none; }
  .mv-head th, .mv-head td { border: none !important; background: none !important; font-family: 'Segoe UI', Arial, sans-serif !important; color: #0f172a; }
  .mv-head th { text-align: left; color: #64748b; font-weight: 500; padding: 2px 12px 2px 0 !important; width: 90px; vertical-align: top; white-space: nowrap; }
  .mv-head td { padding: 2px 0 !important; word-break: break-word; }
  .mv-email-body { font-family: 'Segoe UI', Calibri, Arial, sans-serif; font-size: 10.5pt; color: #111; overflow-wrap: anywhere; }
  .mv-email-body img { max-width: 100%; height: auto; }
  .mv-email-body table { max-width: 100% !important; }
  .mv-text { white-space: pre-wrap; font-family: Consolas, 'Cascadia Mono', monospace; font-size: 9.5pt; }
</style>
<style>${styles.replace(/<\/style/gi, '')}</style>
</head><body>
<div class="mv-head"><h1>${escapeHtml(email.subject || '(no subject)')}</h1><table>${header}</table></div>
${body}
</body></html>`;
}
