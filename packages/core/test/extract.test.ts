import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yazl from 'yazl';
import { attachmentFilterSchema } from '@mailvault/shared';
import { acceptInnerFile, containerKindOf, filterAttachments } from '../src/rule-engine.js';
import { DEFAULT_LIMITS, ExtractError, extractToTemp } from '../src/node/extract.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mv-extract-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeZip(file: string, entries: { name: string; data: string | Buffer; compress?: boolean }[]) {
  return new Promise<void>((ok, fail) => {
    const z = new yazl.ZipFile();
    for (const e of entries) z.addBuffer(Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data), e.name, { compress: e.compress ?? true });
    z.end();
    z.outputStream.pipe(createWriteStream(file)).on('close', () => ok()).on('error', fail);
  });
}

const policy = { blockedExtensions: ['exe'], maxSizeMb: 10, includeInline: false };
const rule = attachmentFilterSchema.parse({ mode: 'SELECTED', extensions: ['pdf', 'xlsx'], excludeNames: ['terms'], extractArchives: true, extractEmails: true });
const accept = (name: string, size: number, inline: boolean) => acceptInnerFile(rule, name, size, inline, policy);

describe('deciding what to unpack', () => {
  it('recognises containers', () => {
    expect(containerKindOf('Invoices.ZIP')).toBe('zip');
    expect(containerKindOf('fwd.eml')).toBe('eml');
    expect(containerKindOf('mail.msg')).toBe('msg');
    expect(containerKindOf('Forwarded', 'item')).toBe('eml');
    expect(containerKindOf('a.pdf')).toBeNull();
  });

  it('marks containers for extraction only when the rule asks for it', () => {
    const files = [
      { id: '1', name: 'docs.zip', size: 1000, isInline: false, kind: 'file' as const },
      { id: '2', name: 'Fwd', size: 1000, isInline: false, kind: 'item' as const },
      { id: '3', name: 'a.pdf', size: 1000, isInline: false, kind: 'file' as const },
    ];
    expect(filterAttachments(rule, files, policy).map((d) => [d.saveName, d.include, d.extract ?? null])).toEqual([
      ['docs.zip', true, 'zip'],
      ['Fwd.eml', true, 'eml'],
      ['a.pdf', true, null],
    ]);
    const off = attachmentFilterSchema.parse({ mode: 'SELECTED', extensions: ['pdf'] });
    expect(filterAttachments(off, files, policy).map((d) => d.include)).toEqual([false, false, true]);
  });
});

describe('ZIP extraction', () => {
  it('unpacks matching files, flattens folders, and explains skipped ones', async () => {
    const zip = join(dir, 'a.zip');
    await makeZip(zip, [
      { name: 'invoices/2026/INV-1.pdf', data: 'pdf one' },
      { name: 'INV-2.xlsx', data: 'sheet' },
      { name: 'terms.pdf', data: 'tc' },
      { name: 'readme.txt', data: 'hi' },
      { name: 'setup.exe', data: 'MZ' },
      { name: 'zz/zz/escape.pdf', data: 'evil' },
    ]);
    // yazl refuses to write "../" names, so patch them in afterwards (same length) like a malicious archive would.
    const bytes = await readFile(zip);
    await writeFile(zip, Buffer.from(bytes.toString('latin1').replaceAll('zz/zz/escape.pdf', '../../escape.pdf'), 'latin1'));
    const r = await extractToTemp(zip, 'zip', join(dir, 't1'), accept);
    expect(r.files.map((f) => [f.name, f.innerPath])).toEqual([
      ['INV-1.pdf', 'invoices/2026/INV-1.pdf'],
      ['INV-2.xlsx', 'INV-2.xlsx'],
      ['escape.pdf', '../../escape.pdf'], // saved under its plain name, never outside the folder
    ]);
    expect(await readFile(r.files[0]!.tmpPath, 'utf8')).toBe('pdf one');
    expect(Object.fromEntries(r.skipped.map((s) => [s.innerPath, s.reason]))).toEqual({
      'terms.pdf': 'Name is in the exclude list',
      'readme.txt': 'File type .txt not selected in rule',
      'setup.exe': 'Blocked file type (.exe)',
    });
  });

  it('refuses zip bombs and caps the number of files', async () => {
    const bomb = join(dir, 'bomb.zip');
    await makeZip(bomb, [{ name: 'huge.pdf', data: Buffer.alloc(30 * 1024 * 1024) }]); // 30 MB of zeros → tiny when zipped
    const r = await extractToTemp(bomb, 'zip', join(dir, 't2'), accept);
    expect(r.files).toEqual([]);
    expect(r.skipped[0]!.reason).toBe('Suspicious compression ratio (possible zip bomb)');

    const many = join(dir, 'many.zip');
    await makeZip(many, Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.pdf`, data: `n${i}` })));
    const capped = await extractToTemp(many, 'zip', join(dir, 't3'), accept, { ...DEFAULT_LIMITS, maxEntries: 5 });
    expect(capped.files).toHaveLength(5);
    expect(capped.skipped.at(-1)!.reason).toMatch(/more than 5 files/);
  });

  it('reports a damaged archive clearly', async () => {
    const bad = join(dir, 'bad.zip');
    await writeFile(bad, 'this is not a zip file');
    await expect(extractToTemp(bad, 'zip', join(dir, 't4'), accept)).rejects.toBeInstanceOf(ExtractError);
  });
});

describe('attached email extraction', () => {
  it('unpacks attachments of an .eml, skipping inline images and non-matching files', async () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    const eml = [
      'From: Vendor <billing@vendor.com>',
      'To: accounts@company.com',
      'Subject: Fwd: Invoice',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="XYZ"',
      '',
      '--XYZ',
      'Content-Type: text/plain',
      '',
      'Please find attached.',
      '--XYZ',
      'Content-Type: application/pdf; name="INV-9.pdf"',
      'Content-Disposition: attachment; filename="INV-9.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      b64('pdf nine'),
      '--XYZ',
      'Content-Type: image/png; name="logo.png"',
      'Content-Disposition: inline; filename="logo.png"',
      'Content-ID: <logo>',
      'Content-Transfer-Encoding: base64',
      '',
      b64('png'),
      '--XYZ',
      'Content-Type: text/plain; name="notes.txt"',
      'Content-Disposition: attachment; filename="notes.txt"',
      '',
      'notes',
      '--XYZ--',
      '',
    ].join('\r\n');
    const file = join(dir, 'fwd.eml');
    await writeFile(file, eml);
    const r = await extractToTemp(file, 'eml', join(dir, 't5'), accept);
    expect(r.files.map((f) => f.name)).toEqual(['INV-9.pdf']);
    expect(await readFile(r.files[0]!.tmpPath, 'utf8')).toBe('pdf nine');
    expect(r.skipped.map((s) => [s.innerPath, s.reason])).toEqual([
      ['logo.png', 'Inline image excluded'],
      ['notes.txt', 'File type .txt not selected in rule'],
    ]);
  });

  it('reports an unreadable Outlook message clearly', async () => {
    const file = join(dir, 'broken.msg');
    await writeFile(file, 'not an outlook file');
    await expect(extractToTemp(file, 'msg', join(dir, 't6'), accept)).rejects.toBeInstanceOf(ExtractError);
  });
});
