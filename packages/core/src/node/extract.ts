// Safe unpacking of .zip archives and attached emails (.eml / Outlook .msg).
// Protects against zip bombs (size, count and compression-ratio limits), path tricks in entry names,
// and password-protected or damaged archives. Files are unpacked to a temp folder; the caller saves them.
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { simpleParser } from 'mailparser';
import MsgReaderModule from '@kenjiuno/msgreader';
import type { ContainerKind } from '../rule-engine.js';

// @kenjiuno/msgreader ships CommonJS with a default export.
const MsgReader = ((MsgReaderModule as unknown as { default?: unknown }).default ?? MsgReaderModule) as new (b: ArrayBuffer) => {
  getFileData(): { attachments?: { fileName?: string; fileNameShort?: string; contentLength?: number; innerMsgContent?: boolean; attachMimeTag?: string }[] };
  getAttachment(a: unknown): { fileName: string; content: Uint8Array };
};

export interface ExtractLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** Uncompressed ÷ compressed; real documents are far below 100. */
  maxRatio: number;
}

export const DEFAULT_LIMITS: ExtractLimits = { maxEntries: 500, maxEntryBytes: 150 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024, maxRatio: 200 };

export interface ExtractedFile {
  name: string; // file name only (no folders)
  innerPath: string; // path inside the archive / email, for the record
  tmpPath: string;
  size: number;
}

export interface ExtractResult {
  files: ExtractedFile[];
  skipped: { innerPath: string; reason: string }[];
}

export class ExtractError extends Error {
  code = 'EXTRACT_FAILED';
}

export type AcceptFn = (name: string, size: number, isInline: boolean) => { include: boolean; reason?: string };

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? 'file';

export async function extractToTemp(containerFile: string, kind: ContainerKind, tmpDir: string, accept: AcceptFn, limits: ExtractLimits = DEFAULT_LIMITS): Promise<ExtractResult> {
  await mkdir(tmpDir, { recursive: true });
  if (kind === 'zip') return extractZip(containerFile, tmpDir, accept, limits);
  const buf = await readFile(containerFile);
  return kind === 'eml' ? extractEml(buf, tmpDir, accept, limits) : extractMsg(buf, tmpDir, accept, limits);
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((ok, fail) =>
    // decodeStrings: false → yauzl does not reject the whole archive because one entry has a malicious
    // name like "../../x"; we decode names ourselves and only ever use the plain file name.
    yauzl.open(file, { lazyEntries: true, autoClose: true, validateEntrySizes: true, strictFileNames: false, decodeStrings: false }, (err, zip) => (err ? fail(err) : ok(zip!))),
  );
}

async function extractZip(file: string, tmpDir: string, accept: AcceptFn, limits: ExtractLimits): Promise<ExtractResult> {
  let zip: yauzl.ZipFile;
  try {
    zip = await openZip(file);
  } catch (err) {
    throw new ExtractError(`The ZIP file is damaged or not a valid ZIP (${(err as Error).message})`);
  }
  const result: ExtractResult = { files: [], skipped: [] };
  let total = 0;
  let count = 0;

  await new Promise<void>((done, fail) => {
    zip.on('error', (err: Error) => fail(new ExtractError(`Could not read the ZIP file: ${err.message}`)));
    zip.on('end', () => done());
    zip.on('entry', (entry: yauzl.Entry) => {
      // Bit 11 = UTF-8 names; otherwise the legacy DOS code page (latin1 is a close, safe approximation).
      const raw = entry.fileName as unknown as Buffer;
      const innerPath = Buffer.isBuffer(raw) ? raw.toString(entry.generalPurposeBitFlag & 0x800 ? 'utf8' : 'latin1') : String(raw);
      const next = () => zip.readEntry();
      const skip = (reason: string) => {
        result.skipped.push({ innerPath, reason });
        next();
      };
      if (/\/$/.test(innerPath)) return next(); // folder entry
      if (++count > limits.maxEntries) {
        result.skipped.push({ innerPath: '(remaining files)', reason: `Archive has more than ${limits.maxEntries} files; the rest were not unpacked` });
        zip.close();
        return done();
      }
      if (entry.generalPurposeBitFlag & 0x1) return skip('Password-protected file');
      const size = entry.uncompressedSize;
      if (entry.compressedSize > 0 && size / entry.compressedSize > limits.maxRatio) return skip('Suspicious compression ratio (possible zip bomb)');
      if (size > limits.maxEntryBytes) return skip(`Larger than the ${Math.round(limits.maxEntryBytes / 1048576)} MB limit`);
      if (total + size > limits.maxTotalBytes) return skip('Archive contents exceed the total size limit');
      const name = baseName(innerPath);
      const verdict = accept(name, size, false);
      if (!verdict.include) return skip(verdict.reason ?? 'Not selected by the rule');

      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return skip(`Could not read this file (${err?.message ?? 'unknown error'})`);
        const tmpPath = join(tmpDir, `${randomUUID()}.part`);
        pipeline(stream as Readable, createWriteStream(tmpPath))
          .then(() => {
            total += size;
            result.files.push({ name, innerPath, tmpPath, size });
            next();
          })
          .catch((e: Error) => skip(`Could not unpack (${e.message})`));
      });
    });
    zip.readEntry();
  });
  return result;
}

async function extractEml(buf: Buffer, tmpDir: string, accept: AcceptFn, limits: ExtractLimits): Promise<ExtractResult> {
  let parsed;
  try {
    parsed = await simpleParser(buf, { skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true });
  } catch (err) {
    throw new ExtractError(`The attached email could not be read (${(err as Error).message})`);
  }
  const result: ExtractResult = { files: [], skipped: [] };
  let total = 0;
  for (const [i, a] of parsed.attachments.entries()) {
    const name = baseName(a.filename ?? `attachment-${i + 1}`);
    if (i >= limits.maxEntries) {
      result.skipped.push({ innerPath: name, reason: 'Too many attachments' });
      continue;
    }
    const isInline = a.contentDisposition === 'inline' || Boolean(a.related);
    if (a.size > limits.maxEntryBytes || total + a.size > limits.maxTotalBytes) {
      result.skipped.push({ innerPath: name, reason: 'Larger than the size limit' });
      continue;
    }
    const verdict = accept(name, a.size, isInline);
    if (!verdict.include) {
      result.skipped.push({ innerPath: name, reason: verdict.reason ?? 'Not selected by the rule' });
      continue;
    }
    const tmpPath = join(tmpDir, `${randomUUID()}.part`);
    await writeFile(tmpPath, a.content);
    total += a.size;
    result.files.push({ name, innerPath: name, tmpPath, size: a.size });
  }
  return result;
}

async function extractMsg(buf: Buffer, tmpDir: string, accept: AcceptFn, limits: ExtractLimits): Promise<ExtractResult> {
  let reader;
  let data;
  try {
    reader = new MsgReader(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    data = reader.getFileData() as ReturnType<typeof reader.getFileData> & { error?: string };
    if (data.error) throw new Error(data.error);
  } catch (err) {
    throw new ExtractError(`The attached Outlook message could not be read (${(err as Error).message})`);
  }
  const result: ExtractResult = { files: [], skipped: [] };
  let total = 0;
  for (const [i, att] of (data.attachments ?? []).entries()) {
    const name = baseName(att.fileName ?? att.fileNameShort ?? `attachment-${i + 1}`);
    if (att.innerMsgContent) {
      result.skipped.push({ innerPath: name, reason: 'Email inside an email inside an email (not unpacked further)' });
      continue;
    }
    if (i >= limits.maxEntries) {
      result.skipped.push({ innerPath: name, reason: 'Too many attachments' });
      continue;
    }
    let content: Uint8Array;
    try {
      content = reader.getAttachment(att).content;
    } catch (err) {
      result.skipped.push({ innerPath: name, reason: `Could not read (${(err as Error).message})` });
      continue;
    }
    if (content.length > limits.maxEntryBytes || total + content.length > limits.maxTotalBytes) {
      result.skipped.push({ innerPath: name, reason: 'Larger than the size limit' });
      continue;
    }
    const verdict = accept(name, content.length, false);
    if (!verdict.include) {
      result.skipped.push({ innerPath: name, reason: verdict.reason ?? 'Not selected by the rule' });
      continue;
    }
    const tmpPath = join(tmpDir, `${randomUUID()}.part`);
    await writeFile(tmpPath, content);
    total += content.length;
    result.files.push({ name, innerPath: name, tmpPath, size: content.length });
  }
  return result;
}
