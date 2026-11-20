import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, openAsBlob } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BlobReader, BlobWriter, TextReader, TextWriter, Uint8ArrayReader, ZipReader, ZipWriter, type FileEntry } from '@zip.js/zip.js';
import { unlockFile, unlockKindOf, unlockPdf, unlockZip } from '../src/node/unlock.js';

// qpdf is needed for the PDF tests; they are skipped on machines without it.
const QPDF = process.env.QPDF_PATH ?? 'D:/Investoyard/.tools/qpdf/bin/qpdf.exe';
const hasQpdf = existsSync(QPDF);

let dir: string;

/** A minimal valid one-page PDF (with a correct cross-reference table). */
const PDF = (() => {
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>>>'];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return `${out}trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
})();

async function makeZip(path: string, files: Record<string, string | Uint8Array>, opts: { password?: string; zipCrypto?: boolean } = {}) {
  const writer = new ZipWriter(new BlobWriter('application/zip'), { password: opts.password, zipCrypto: opts.zipCrypto });
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith('/')) await writer.add(name, undefined, { directory: true });
    else await writer.add(name, typeof content === 'string' ? new TextReader(content) : new Uint8ArrayReader(content));
  }
  await writeFile(path, Buffer.from(await (await writer.close()).arrayBuffer()));
}

async function readZip(path: string) {
  const reader = new ZipReader(new BlobReader(await openAsBlob(path)));
  const entries = await reader.getEntries();
  const out: Record<string, { encrypted: boolean; text?: string }> = {};
  for (const e of entries) out[e.filename] = { encrypted: e.encrypted, text: e.directory ? undefined : await e.getData!(new TextWriter()) };
  await reader.close();
  return out;
}

beforeAll(async () => {
  dir = await mkdtemp(join(resolve(import.meta.dirname, '..'), 'tmp-unlock-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('unlockKindOf', () => {
  it('knows PDF and ZIP only', () => {
    expect(unlockKindOf('Statement.PDF')).toBe('pdf');
    expect(unlockKindOf('a.b.zip')).toBe('zip');
    expect(unlockKindOf('report.xlsx')).toBeNull();
  });
});

describe('unlockZip', () => {
  for (const [label, zipCrypto] of [['legacy ZipCrypto', true], ['AES', false]] as const) {
    it(`re-packs a ${label} ZIP without a password, trying passwords in order`, async () => {
      const src = join(dir, `${label}.zip`);
      await makeZip(src, { 'Statements/': '', 'Statements/a.csv': 'x,y\n1,2', 'b.txt': 'hello' }, { password: 'Secret#1', zipCrypto });
      const out = join(dir, `${label}-out.zip`);
      const r = await unlockZip(src, out, ['wrong', 'Secret#1'], { workDir: dir });
      expect(r.protection).toBe('UNLOCKED');
      expect(r.path).toBe(out);
      const files = await readZip(out);
      expect(Object.keys(files).sort()).toEqual(['Statements/', 'Statements/a.csv', 'b.txt']);
      expect(files['Statements/a.csv']).toEqual({ encrypted: false, text: 'x,y\n1,2' });
      expect(files['b.txt']!.text).toBe('hello');
    });
  }

  it('keeps the original when no password works', async () => {
    const src = join(dir, 'locked.zip');
    await makeZip(src, { 'a.txt': 'secret data' }, { password: 'right', zipCrypto: true });
    const r = await unlockZip(src, join(dir, 'never.zip'), ['nope', 'also-wrong'], { workDir: dir });
    expect(r).toMatchObject({ protection: 'STILL_LOCKED', path: src });
    expect(r.note).toMatch(/None of the 2 saved password/);
    expect(existsSync(join(dir, 'never.zip'))).toBe(false);
  });

  it('leaves unprotected ZIPs alone', async () => {
    const src = join(dir, 'plain.zip');
    await makeZip(src, { 'a.txt': 'a' });
    expect(await unlockZip(src, join(dir, 'x.zip'), ['pw'], { workDir: dir })).toEqual({ protection: 'NONE', path: src });
  });

  it('reports a damaged file instead of throwing', async () => {
    const src = join(dir, 'broken.zip');
    await writeFile(src, 'not a zip at all');
    const r = await unlockZip(src, join(dir, 'y.zip'), ['pw'], { workDir: dir });
    expect(r.protection).toBe('NONE');
    expect(r.note).toMatch(/Not a readable ZIP/);
  });
});

describe.skipIf(!hasQpdf)('unlockPdf (qpdf)', () => {
  const encrypt = (src: string, dst: string, user: string) =>
    execFileSync(QPDF, ['--encrypt', `--user-password=${user}`, '--owner-password=owner-pw', '--bits=256', '--print=none', '--', src, dst]);
  const isEncrypted = (p: string) => {
    try {
      execFileSync(QPDF, ['--is-encrypted', p]);
      return true;
    } catch {
      return false;
    }
  };

  it('removes an open password', async () => {
    const plain = join(dir, 'plain.pdf');
    await writeFile(plain, PDF);
    encrypt(plain, join(dir, 'locked.pdf'), 'ABCDE1234F');
    const r = await unlockPdf(join(dir, 'locked.pdf'), join(dir, 'out.pdf'), ['wrong', 'ABCDE1234F'], QPDF);
    expect(r).toEqual({ protection: 'UNLOCKED', path: join(dir, 'out.pdf') });
    expect(isEncrypted(r.path)).toBe(false);
  });

  it('gives the same bytes every time (so duplicate checks still work)', async () => {
    await unlockPdf(join(dir, 'locked.pdf'), join(dir, 'out2.pdf'), ['ABCDE1234F'], QPDF);
    expect(Buffer.compare(await readFile(join(dir, 'out.pdf')), await readFile(join(dir, 'out2.pdf')))).toBe(0);
  });

  it('removes print/copy restrictions without a password', async () => {
    encrypt(join(dir, 'plain.pdf'), join(dir, 'restricted.pdf'), '');
    const r = await unlockPdf(join(dir, 'restricted.pdf'), join(dir, 'free.pdf'), [], QPDF);
    expect(r.protection).toBe('RESTRICTIONS_REMOVED');
    expect(isEncrypted(r.path)).toBe(false);
  });

  it('keeps the original when no password works', async () => {
    const r = await unlockPdf(join(dir, 'locked.pdf'), join(dir, 'no.pdf'), ['x'], QPDF);
    expect(r).toMatchObject({ protection: 'STILL_LOCKED', path: join(dir, 'locked.pdf') });
  });

  it('leaves normal PDFs alone', async () => {
    expect(await unlockPdf(join(dir, 'plain.pdf'), join(dir, 'n.pdf'), ['x'], QPDF)).toEqual({ protection: 'NONE', path: join(dir, 'plain.pdf') });
  });

  it('unlocks protected PDFs inside a protected ZIP', async () => {
    const pdf = await readFile(join(dir, 'locked.pdf'));
    const src = join(dir, 'with-pdf.zip');
    await makeZip(src, { 'Statement.pdf': new Uint8Array(pdf), 'note.txt': 'n' }, { password: 'ABCDE1234F', zipCrypto: true });
    const r = await unlockFile(src, 'with-pdf.zip', ['ABCDE1234F'], { workDir: dir, qpdf: QPDF });
    expect(r.protection).toBe('UNLOCKED');
    expect(r.note).toBe('1 PDF(s) inside also unlocked');
    const reader = new ZipReader(new BlobReader(await openAsBlob(r.path)));
    const entry = (await reader.getEntries()).find((e) => e.filename === 'Statement.pdf' && !e.directory) as FileEntry;
    const inner = join(dir, 'inner.pdf');
    await writeFile(inner, Buffer.from(await (await entry.getData(new BlobWriter())).arrayBuffer()));
    await reader.close();
    expect(isEncrypted(inner)).toBe(false);
  });
});
