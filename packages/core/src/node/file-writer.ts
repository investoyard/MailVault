// Safe attachment writer: stream → temp file (+ SHA-256) → duplicate policy → atomic move into place.
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsc, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, link, mkdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DuplicatePolicy } from '@mailvault/shared';
import { numberedFileName, type CopyNumbering } from '../filename.js';
import { assertRootExists } from './fs-root.js';

export interface SaveOptions {
  source: Readable | NodeJS.ReadableStream;
  folder: string;
  fileName: string; // already sanitized
  policy: DuplicatePolicy;
  fileDate?: Date; // set modified time (e.g. email received date)
  maxBytes?: number;
  /** Names of extra copies (Rename / Smart): "name (1).pdf" (default) or "name 2.pdf". */
  numbering?: CopyNumbering;
}

export type SaveResult =
  | { status: 'SAVED'; path: string; fileName: string; sha256: string; bytes: number; replaced: boolean }
  | { status: 'SKIPPED'; path: string; fileName: string; sha256: string; bytes: number; reason: string };

export class FileTooLargeError extends Error {
  code = 'EFBIG';
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), async function* (src) {
    for await (const chunk of src) h.update(chunk as Buffer);
  });
  return h.digest('hex');
}

const exists = async (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Creates `target` from `tmp` only if target does not exist yet (atomic on NTFS/SMB via hard link). */
async function placeExclusive(tmp: string, target: string): Promise<boolean> {
  try {
    await link(tmp, target);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    // File systems without hard links: exclusive copy instead.
    try {
      await copyFile(tmp, target, fsc.COPYFILE_EXCL);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
  }
}

export async function saveAttachment(o: SaveOptions): Promise<SaveResult> {
  await assertRootExists(o.folder);
  await mkdir(o.folder, { recursive: true });
  const tmpDir = join(o.folder, '.mailvault-tmp');
  await mkdir(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `${randomUUID()}.part`);

  try {
    // 1. Stream to temp file while hashing and counting.
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (o.maxBytes && bytes > o.maxBytes) return cb(new FileTooLargeError(`File is larger than ${Math.round(o.maxBytes / 1048576)} MB`));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(o.source as Readable, meter, createWriteStream(tmp, { flags: 'wx' }));
    const sha256 = hash.digest('hex');
    if (o.fileDate) await utimes(tmp, o.fileDate, o.fileDate);

    const target = join(o.folder, o.fileName);
    const saved = (fileName: string, replaced = false): SaveResult => ({
      status: 'SAVED',
      path: join(o.folder, fileName),
      fileName,
      sha256,
      bytes,
      replaced,
    });
    const skipped = (fileName: string, reason: string): SaveResult => ({
      status: 'SKIPPED',
      path: join(o.folder, fileName),
      fileName,
      sha256,
      bytes,
      reason,
    });

    // 2. No conflict: place it.
    if (await placeExclusive(tmp, target)) return saved(o.fileName);

    // 3. Conflict: apply the duplicate policy.
    switch (o.policy) {
      case 'SKIP':
        return skipped(o.fileName, 'A file with this name already exists (Skip duplicate policy)');
      case 'REPLACE':
        await rename(tmp, target); // replaces existing file atomically
        return saved(o.fileName, true);
      case 'RENAME':
      case 'SMART': {
        let candidate = o.fileName;
        for (let n = 1; n <= 999; n++) {
          const path = join(o.folder, candidate);
          if (o.policy === 'SMART' && (await exists(path)) && (await sha256File(path)) === sha256) {
            return skipped(candidate, 'Identical file already exists (Smart duplicate policy)');
          }
          if (n > 1 || candidate !== o.fileName) {
            if (await placeExclusive(tmp, path)) return saved(candidate);
          }
          candidate = numberedFileName(o.fileName, n, o.numbering);
        }
        throw new Error('Too many files with the same name (999)');
      }
    }
  } finally {
    await rm(tmp, { force: true });
  }
}
