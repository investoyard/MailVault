import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  browseFolders,
  createSubfolder,
  isBlocked,
  isInside,
  normalizeFolderPath,
  runFolderOp,
} from '../src/node/folder-browse.js';

// Not under %TEMP%: that lives in C:\Users, which the picker deliberately hides.
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(resolve(import.meta.dirname, '..'), 'tmp-browse-'));
  await mkdir(join(dir, 'Invoices'));
  await mkdir(join(dir, 'archive 10'));
  await mkdir(join(dir, 'archive 9'));
  await mkdir(join(dir, '.mailvault-tmp'));
  await mkdir(join(dir, '$Recycle.Bin'));
  await writeFile(join(dir, 'secret.txt'), 'not listed');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('normalizeFolderPath', () => {
  it('cleans local and UNC paths', () => {
    expect(normalizeFolderPath(' d:/Finance//Invoices\\ ')).toBe('D:\\Finance\\Invoices');
    expect(normalizeFolderPath('D:')).toBe('D:\\');
    expect(normalizeFolderPath('D:\\')).toBe('D:\\');
    expect(normalizeFolderPath('D:\\a\\..\\b')).toBe('D:\\b');
    expect(normalizeFolderPath('\\\\fs01\\share\\Acc\\')).toBe('\\\\fs01\\share\\Acc');
  });
  it('rejects relative paths and mapped-drive-less input', () => {
    expect(() => normalizeFolderPath('Finance')).toThrow(/local path/);
    expect(() => normalizeFolderPath('\\\\server')).toThrow();
  });
});

describe('isInside / isBlocked', () => {
  it('matches whole segments, case-insensitively', () => {
    expect(isInside('d:\\files\\a', 'D:\\Files')).toBe(true);
    expect(isInside('D:\\Files', 'D:\\Files\\')).toBe(true);
    expect(isInside('D:\\Files2', 'D:\\Files')).toBe(false);
  });
  it('blocks Windows system locations and hidden segments', () => {
    const blocked = ['C:\\Windows', 'C:\\Program Files', 'C:\\Users'];
    expect(isBlocked('C:\\Windows\\System32', blocked)).toBe(true);
    expect(isBlocked('c:\\users\\bob', blocked)).toBe(true);
    expect(isBlocked('D:\\Data\\$Recycle.Bin', blocked)).toBe(true);
    expect(isBlocked('D:\\Data\\.mailvault-tmp', blocked)).toBe(true);
    expect(isBlocked('D:\\Data\\Invoices', blocked)).toBe(false);
  });
});

describe('browseFolders', () => {
  it('lists sub-folder names only, sorted naturally, without hidden ones', async () => {
    const l = await browseFolders(dir);
    expect(l.folders.map((f) => f.name)).toEqual(['archive 9', 'archive 10', 'Invoices']);
    expect(l.folders[2]!.path).toBe(join(dir, 'Invoices'));
    expect(l.parent).toBe(resolve(dir, '..'));
  });
  it('lists drives at the top level', async () => {
    const l = await browseFolders(null);
    expect(l.path).toBeNull();
    expect(l.folders.some((f) => f.path === `${dir[0]!.toUpperCase()}:\\`)).toBe(true);
  });
  it('lists only the configured roots when set, and refuses paths outside them', async () => {
    const top = await browseFolders('', [dir]);
    expect(top.folders).toEqual([{ name: dir, path: dir }]);
    const inRoot = await browseFolders(dir, [dir]);
    expect(inRoot.parent).toBeNull();
    await expect(browseFolders('D:\\', [dir])).rejects.toThrow(/Only folders inside/);
  });
  it('refuses system folders', async () => {
    await expect(browseFolders(process.env.SystemRoot ?? 'C:\\Windows')).rejects.toThrow(/system folder/);
  });
});

describe('createSubfolder / runFolderOp', () => {
  it('creates a folder and refuses bad names and duplicates', async () => {
    const p = await createSubfolder(dir, 'Vendor bills');
    expect((await stat(p)).isDirectory()).toBe(true);
    await expect(createSubfolder(dir, 'Vendor bills')).rejects.toThrow(/already exists/);
    await expect(createSubfolder(dir, 'a/b')).rejects.toThrow(/cannot contain/);
    await expect(createSubfolder(dir, '..')).rejects.toThrow(/cannot contain/);
  });
  it('returns readable errors instead of throwing', async () => {
    const r = await runFolderOp({ op: 'browse', path: join(dir, 'missing') });
    expect(r).toMatchObject({ ok: false, error: 'Path not found or network share unreachable' });
    expect(r.account).toBeTruthy();
  });
  it('tests a folder by writing to it', async () => {
    const r = await runFolderOp({ op: 'test', path: join(dir, 'new-dest'), createIfMissing: true, lowSpaceThresholdMb: 1 });
    expect(r).toMatchObject({ ok: true, check: { status: 'HEALTHY', error: null } });
  });
});
