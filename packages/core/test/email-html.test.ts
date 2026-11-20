import { describe, expect, it } from 'vitest';
import { buildEmailHtml, sanitizeEmailHtml } from '../src/email-html.js';
import type { EmailContent } from '../src/provider.js';

const email = (body: EmailContent['body'], extra: Partial<EmailContent> = {}): EmailContent => ({
  subject: 'Contract note <15-Nov>',
  from: { email: 'ops@broker.com', name: 'Broker Ops' },
  to: [{ email: 'aif@finwave.co' }],
  cc: [],
  receivedAt: new Date('2026-11-15T10:30:00Z'),
  body,
  attachmentNames: ['note.pdf'],
  inlineImages: [],
  ...extra,
});

describe('sanitizeEmailHtml', () => {
  it('removes scripts, frames, forms, event handlers and dangerous links', () => {
    const { body } = sanitizeEmailHtml(
      '<html><head><script>x()</script></head><body><p onclick="evil()">Hi</p><script>alert(1)</script>' +
        '<iframe src="https://x"></iframe><form action="https://x"><input name=a></form>' +
        '<a href="javascript:alert(1)">l</a><img src="file:///C:/Windows/win.ini"><meta http-equiv="refresh" content="0;url=https://x"></body></html>',
    );
    expect(body).not.toMatch(/script|iframe|<form|<input|onclick|javascript:|file:|refresh/i);
    expect(body).toContain('<p>Hi</p>');
  });

  it('keeps the email styles but drops @import', () => {
    const { styles } = sanitizeEmailHtml('<head><style>@import url(https://x/a.css); p{color:red}</style></head><body>x</body>');
    expect(styles.trim()).toBe('p{color:red}');
  });

  it('embeds cid: pictures as data URIs', () => {
    const { body } = sanitizeEmailHtml('<body><img src="cid:image001.png@01DA1234.5678"><img src="cid:unknown"></body>', [
      { contentId: 'image001.png@01DA1234.5678', name: 'image001.png', contentType: 'image/png', base64: 'AAAA' },
    ]);
    expect(body).toContain('src="data:image/png;base64,AAAA"');
    expect(body).toContain('src="cid:unknown"');
  });
});

describe('buildEmailHtml', () => {
  it('builds the header block in the business time zone and escapes values', () => {
    const html = buildEmailHtml(email({ type: 'text', content: 'Line 1\n<b>not bold</b>' }), { timeZone: 'Asia/Kolkata' });
    expect(html).toContain('<h1>Contract note &lt;15-Nov&gt;</h1>');
    expect(html).toContain('Broker Ops &lt;ops@broker.com&gt;');
    expect(html).toContain('15 November 2026, 16:00 (Asia/Kolkata)');
    expect(html).toContain('<th>Attachments</th><td>note.pdf</td>');
    expect(html).not.toContain('<th>Cc</th>');
    expect(html).toContain('&lt;b&gt;not bold&lt;/b&gt;');
  });

  it('blocks internet pictures unless the rule allows them', () => {
    const body = { type: 'html' as const, content: '<p>x</p>' };
    expect(buildEmailHtml(email(body), { timeZone: 'UTC' })).toContain("img-src data:\"");
    expect(buildEmailHtml(email(body), { timeZone: 'UTC', allowRemoteImages: true })).toContain('img-src data: https: http:');
  });
});
