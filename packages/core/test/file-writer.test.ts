import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { FileTooLargeError, saveAttachment } from '../src/node/file-writer.js';

let dir: string;
const roots: string[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mv-writer-'));
  roots.push(dir);
});
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const src = (text: string) => Readable.from([Buffer.from(text)]);
const save = (text: string, policy: 'SKIP' | 'REPLACE' | 'RENAME' | 'SMART', extra = {}) =>
  saveAttachment({ source: src(text), folder: dir, fileName: 'invoice.pdf', policy, ...extra });
const files = async () => (await readdir(dir)).filter((f) => !f.startsWith('.')).sort();

describe('saveAttachment', () => {
  it('saves a new file with hash and leaves no temp files', async () => {
    const r = await save('hello', 'SMART');
    expect(r).toMatchObject({ status: 'SAVED', fileName: 'invoice.pdf', bytes: 5 });
    expect(r.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(await readFile(join(dir, 'invoice.pdf'), 'utf8')).toBe('hello');
    expect(await readdir(join(dir, '.mailvault-tmp'))).toEqual([]);
  });

  it('SKIP keeps the existing file', async () => {
    await save('one', 'SKIP');
    const r = await save('two', 'SKIP');
    expect(r.status).toBe('SKIPPED');
    expect(await readFile(join(dir, 'invoice.pdf'), 'utf8')).toBe('one');
  });

  it('REPLACE overwrites', async () => {
    await save('one', 'REPLACE');
    const r = await save('two', 'REPLACE');
    expect(r).toMatchObject({ status: 'SAVED', replaced: true });
    expect(await readFile(join(dir, 'invoice.pdf'), 'utf8')).toBe('two');
  });

  it('RENAME numbers new copies even when identical', async () => {
    await save('one', 'RENAME');
    await save('one', 'RENAME');
    await save('two', 'RENAME');
    expect(await files()).toEqual(['invoice (1).pdf', 'invoice (2).pdf', 'invoice.pdf']);
  });

  it('SMART skips identical content and renames different content', async () => {
    await save('one', 'SMART');
    const same = await save('one', 'SMART');
    expect(same.status).toBe('SKIPPED');
    const diff = await save('two', 'SMART');
    expect(diff).toMatchObject({ status: 'SAVED', fileName: 'invoice (1).pdf' });
    const sameAsCopy = await save('two', 'SMART');
    expect(sameAsCopy).toMatchObject({ status: 'SKIPPED', fileName: 'invoice (1).pdf' });
    expect(await files()).toEqual(['invoice (1).pdf', 'invoice.pdf']);
  });

  it('handles parallel writers of the same name without losing files', async () => {
    await Promise.all(['a', 'b', 'c', 'd'].map((t) => save(t, 'RENAME')));
    expect((await files()).length).toBe(4);
  });

  it('sets the file date and enforces a size limit', async () => {
    const d = new Date('2026-01-15T10:00:00Z');
    await save('dated', 'SMART', { fileDate: d });
    expect((await stat(join(dir, 'invoice.pdf'))).mtime.toISOString()).toBe(d.toISOString());

    await expect(saveAttachment({ source: src('x'.repeat(2000)), folder: dir, fileName: 'big.bin', policy: 'SMART', maxBytes: 1000 })).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
    expect(await files()).toEqual(['invoice.pdf']);
  });

  it('creates missing folders', async () => {
    const r = await saveAttachment({ source: src('x'), folder: join(dir, 'a', 'b'), fileName: 'f.txt', policy: 'SMART' });
    expect(r.status).toBe('SAVED');
    await writeFile(join(dir, 'z.txt'), '');
  });
});
