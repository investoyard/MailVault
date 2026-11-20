// Removes passwords from protected PDF and ZIP files (rule option "Remove passwords before saving").
// PDFs: qpdf (QPDF_PATH in .env); the password goes in through stdin, never on the command line.
// ZIPs: zip.js reads the protected archive (legacy ZipCrypto or AES) and writes the same files into a new
// ZIP without a password. Everything happens in files under the caller's work folder, never in memory.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, openAsBlob } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import {
  BlobReader,
  ZipReader,
  ZipWriter,
  configure,
  ERR_ENCRYPTED,
  ERR_INVALID_AUTHENTICATION_CODE,
  ERR_INVALID_COMPRESSED_DATA,
  ERR_INVALID_CRC32,
  ERR_INVALID_PASSWORD,
  type Entry,
} from '@zip.js/zip.js';
import { DEFAULT_LIMITS, type ExtractLimits } from './extract.js';

configure({ useWebWorkers: false });

export type Protection = 'NONE' | 'UNLOCKED' | 'RESTRICTIONS_REMOVED' | 'STILL_LOCKED';

export interface UnlockResult {
  protection: Protection;
  /** File to save: the unlocked copy, or the input itself when nothing changed. */
  path: string;
  /** Admin-readable detail (why it is still locked, how many PDFs inside were unlocked, …). */
  note?: string;
}

/** qpdf missing or not runnable: a configuration problem, retried like other temporary errors. */
export class UnlockToolError extends Error {
  code = 'UNLOCK_TOOL';
}

export type UnlockKind = 'pdf' | 'zip';

export function unlockKindOf(name: string): UnlockKind | null {
  const ext = name.toLowerCase().split('.').pop();
  return ext === 'pdf' ? 'pdf' : ext === 'zip' ? 'zip' : null;
}

export function qpdfPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.QPDF_PATH?.trim() || 'qpdf';
}

interface RunResult {
  code: number;
  stderr: string;
}

function runQpdf(qpdf: string, args: string[], stdin = '', timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(qpdf, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 4000) stderr += c.toString();
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new UnlockToolError(
          err.code === 'ENOENT'
            ? `qpdf was not found (${qpdf}). Install qpdf and set QPDF_PATH in .env to remove PDF passwords.`
            : `qpdf could not be started: ${err.message}`,
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr: stderr.trim() });
    });
    child.stdin.on('error', () => undefined); // qpdf may exit before reading stdin
    child.stdin.end(stdin);
  });
}

// qpdf exit codes: 0 = ok, 2 = error, 3 = ok with warnings.
const qpdfOk = (r: RunResult) => r.code === 0 || r.code === 3;

/** Checks whether qpdf runs; returns its version line (for preflight / System Status). */
export async function qpdfVersion(qpdf = qpdfPath()): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(qpdf, ['--version'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', (err) => reject(new UnlockToolError(`qpdf was not found (${qpdf}): ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve(out.split(/\r?\n/)[0] ?? 'qpdf') : reject(new UnlockToolError(`qpdf --version exited with ${code}`))));
  });
}

/**
 * Writes an unprotected copy of `input` to `output`.
 * Tries each password in order; PDFs with only print/copy restrictions are freed without one.
 */
export async function unlockPdf(input: string, output: string, passwords: string[], qpdf = qpdfPath()): Promise<UnlockResult> {
  // --requires-password: 0 = needs a password, 2 = not encrypted, 3 = encrypted but opens without one.
  const check = await runQpdf(qpdf, ['--requires-password', input]);
  if (check.code === 2 && !/encrypt/i.test(check.stderr)) return { protection: 'NONE', path: input };
  if (check.code === 3) {
    const r = await runQpdf(qpdf, ['--decrypt', '--deterministic-id', input, output]);
    return qpdfOk(r) ? { protection: 'RESTRICTIONS_REMOVED', path: output } : { protection: 'NONE', path: input, note: `Restrictions could not be removed: ${r.stderr}` };
  }
  if (check.code !== 0) return { protection: 'NONE', path: input, note: `The PDF could not be checked (${check.stderr || `qpdf exit ${check.code}`}); saved as received` };

  for (const password of passwords) {
    const r = await runQpdf(qpdf, ['--password-file=-', '--decrypt', '--deterministic-id', input, output], password);
    if (qpdfOk(r)) return { protection: 'UNLOCKED', path: output };
  }
  return {
    protection: 'STILL_LOCKED',
    path: input,
    note: passwords.length ? `None of the ${passwords.length} saved password(s) opened this PDF` : 'No password is saved on the rule',
  };
}

const WRONG_PASSWORD = new Set([ERR_INVALID_PASSWORD, ERR_INVALID_CRC32, ERR_INVALID_AUTHENTICATION_CODE, ERR_ENCRYPTED, ERR_INVALID_COMPRESSED_DATA]);

export interface UnlockZipOptions {
  /** Folder for temporary files (inside the destination's .mailvault-tmp). */
  workDir: string;
  limits?: ExtractLimits;
  /** Also remove passwords from PDFs inside the ZIP (same password list). */
  unlockInnerPdfs?: boolean;
  qpdf?: string;
}

/** Writes the ZIP's files into a new ZIP without a password. The original is never changed. */
export async function unlockZip(input: string, output: string, passwords: string[], o: UnlockZipOptions): Promise<UnlockResult> {
  const limits = o.limits ?? DEFAULT_LIMITS;
  const reader = new ZipReader(new BlobReader(await openAsBlob(input)));
  try {
    let entries: Entry[];
    try {
      entries = await reader.getEntries();
    } catch (err) {
      return { protection: 'NONE', path: input, note: `Not a readable ZIP (${(err as Error).message}); saved as received` };
    }
    if (!entries.some((e) => e.encrypted)) return { protection: 'NONE', path: input };
    if (entries.length > limits.maxEntries) {
      return { protection: 'STILL_LOCKED', path: input, note: `The ZIP has more than ${limits.maxEntries} files; it was saved with its password` };
    }
    const total = entries.reduce((n, e) => n + (e.directory ? 0 : e.uncompressedSize), 0);
    const bomb = entries.some((e) => !e.directory && e.compressedSize > 0 && e.uncompressedSize / e.compressedSize > limits.maxRatio);
    if (total > limits.maxTotalBytes || bomb) {
      return { protection: 'STILL_LOCKED', path: input, note: 'The ZIP contents are too large or suspicious (possible zip bomb); it was saved with its password' };
    }

    for (const password of passwords) {
      const dir = join(o.workDir, randomUUID());
      await mkdir(dir, { recursive: true });
      try {
        // 1. Decrypt every file to a temp file (a wrong password fails on the first encrypted file).
        const files: { entry: Entry; tmp?: string }[] = [];
        for (const entry of entries) {
          if (entry.directory) {
            files.push({ entry });
            continue;
          }
          const tmp = join(dir, `${files.length}.bin`);
          const out = createWriteStream(tmp);
          await entry.getData!(Writable.toWeb(out), { password: entry.encrypted ? password : undefined, checkCrc32: true });
          await finished(out);
          files.push({ entry, tmp });
        }

        // 2. Optionally free protected PDFs inside.
        let innerUnlocked = 0;
        let innerLocked = 0;
        if (o.unlockInnerPdfs) {
          for (const f of files) {
            if (!f.tmp || unlockKindOf(f.entry.filename) !== 'pdf') continue;
            const r = await unlockPdf(f.tmp, `${f.tmp}.pdf`, passwords, o.qpdf);
            if (r.protection === 'UNLOCKED' || r.protection === 'RESTRICTIONS_REMOVED') {
              f.tmp = r.path;
              innerUnlocked++;
            } else if (r.protection === 'STILL_LOCKED') innerLocked++;
          }
        }

        // 3. Same names, folders and dates, no password.
        const out = createWriteStream(output);
        const writer = new ZipWriter(Writable.toWeb(out));
        for (const f of files) {
          if (!f.tmp) await writer.add(f.entry.filename, undefined, { directory: true, lastModDate: f.entry.lastModDate });
          else await writer.add(f.entry.filename, Readable.toWeb(createReadStream(f.tmp)) as ReadableStream<Uint8Array>, { lastModDate: f.entry.lastModDate, level: 6 });
        }
        await writer.close();
        await finished(out);

        const notes = [
          innerUnlocked ? `${innerUnlocked} PDF(s) inside also unlocked` : '',
          innerLocked ? `${innerLocked} PDF(s) inside are still password-protected` : '',
        ].filter(Boolean);
        return { protection: 'UNLOCKED', path: output, note: notes.join('; ') || undefined };
      } catch (err) {
        if (WRONG_PASSWORD.has((err as Error).message)) continue;
        throw err;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    return {
      protection: 'STILL_LOCKED',
      path: input,
      note: passwords.length ? `None of the ${passwords.length} saved password(s) opened this ZIP` : 'No password is saved on the rule',
    };
  } finally {
    await reader.close();
  }
}

/** Unlocks a PDF or ZIP into `workDir`; other file types come back unchanged. */
export async function unlockFile(input: string, name: string, passwords: string[], o: UnlockZipOptions): Promise<UnlockResult> {
  const kind = unlockKindOf(name);
  const output = join(o.workDir, `unlocked-${randomUUID()}.${kind ?? 'bin'}`);
  if (kind === 'pdf') return unlockPdf(input, output, passwords, o.qpdf);
  if (kind === 'zip') return unlockZip(input, output, passwords, { unlockInnerPdfs: true, ...o });
  return { protection: 'NONE', path: input };
}
