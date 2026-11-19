/**
 * Zip archives, written deterministically and read within bounds (Phase 1.3,
 * the bible's Markdown bundle).
 *
 * WRITING (`writeZip`) goes through fflate (MIT). The output is a function of
 * the files alone: entries in byte order of their names, DEFLATE at a fixed
 * level (or stored, for an entry that would deflate past `maxRatio`, so the
 * reader's bomb check never refuses what this module wrote), no directory entries, no extra fields, no comment, and one fixed
 * modification time. fflate writes the DOS date from the LOCAL time getters,
 * so the fixed time is built from local components (`new Date(2000, 0, 1)`):
 * its DOS fields are 2000-01-01 00:00 in every timezone, where a UTC instant
 * would move with the server's zone. Nothing of the wall clock reaches the
 * archive, so the same files always zip to the same bytes.
 *
 * READING (`readZip`) is this module's own, over `node:zlib`, because what
 * matters is what it REFUSES, before it allocates:
 *
 *   NOT_A_ZIP               no end-of-central-directory record, or one whose
 *                           directory lies outside the archive
 *   ZIP64_UNSUPPORTED       a ZIP64 archive (nothing this product writes is one)
 *   MULTI_DISK              a spanned archive
 *   TOO_MANY_ENTRIES        more entries than `maxEntries`, refused on the
 *                           record's own count before one entry is read
 *   ENTRY_NAME_UNSAFE       an absolute path, a drive letter, a backslash, a
 *                           `.` / `..` / empty segment, a control character
 *   ENTRY_DUPLICATE         two entries of one name
 *   ENTRY_ENCRYPTED         an encrypted entry
 *   ENTRY_METHOD_UNSUPPORTED  anything but stored or DEFLATE
 *   ENTRY_TOO_LARGE         an entry declaring more than `maxEntryBytes`
 *   ARCHIVE_TOO_LARGE       entries declaring more than `maxTotalBytes` together
 *   ENTRY_RATIO             an entry over `RATIO_EXEMPT_BYTES` that declares
 *                           more than `maxRatio` times its compressed size
 *   ENTRY_CORRUPT           a local header that does not match the directory,
 *                           data outside the archive, an inflated size other
 *                           than the declared one, or a CRC-32 mismatch
 *
 * The declared sizes are the archive's claims, so they are checked twice:
 * summed and bounded BEFORE anything is inflated, and then each entry is
 * inflated with `maxOutputLength` set to its declared size, so an entry that
 * lied about its size stops at the claim (a zip bomb inflates no further than
 * the bounds it declared) and is refused when its output and CRC do not match.
 * Overlapping entries — the "non-recursive" zip bomb — count once per entry
 * against the total, so they are bounded by it too.
 *
 * Nothing is written to disk: an entry's name is a key, never a path, and is
 * checked anyway so a bundle that would be unsafe to unpack is refused here
 * rather than trusted downstream.
 */
import { crc32, inflateRawSync } from 'node:zlib';
import { deflateSync, zipSync, type Zippable } from 'fflate';

// ─── Writing ────────────────────────────────────────────────────────

/** The one modification time every entry carries: local 2000-01-01 00:00, so 2000-01-01 00:00 in DOS fields everywhere. */
export function fixedZipTime(): Date {
    return new Date(2000, 0, 1, 0, 0, 0, 0);
}

/** DEFLATE level for every entry. */
const LEVEL = 6;

/** Compare two names by UTF-16 code unit (the names this product writes are ASCII, so this is byte order). */
function byName(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

export interface WriteZipOptions {
    /**
     * Store (rather than deflate) an entry past `RATIO_EXEMPT_BYTES` that
     * would deflate by more than this ratio, so a reader holding the same
     * `maxRatio` (`readZip`) does not refuse it as a bomb. The choice is a
     * function of the content, so the archive stays deterministic.
     */
    maxRatio?: number;
}

/** The files as a zip archive: byte-identical for identical input. */
export function writeZip(files: ReadonlyMap<string, string | Uint8Array>, options: WriteZipOptions = {}): Uint8Array {
    const encoder = new TextEncoder();
    const mtime = fixedZipTime();
    const tree: Zippable = {};
    for (const name of [...files.keys()].sort(byName)) {
        const content = files.get(name)!;
        const data = typeof content === 'string' ? encoder.encode(content) : content;
        // fflate's zipSync deflates each entry with deflateSync at the same
        // level, so this is the compressed size the archive would declare.
        const store = options.maxRatio !== undefined && data.byteLength > RATIO_EXEMPT_BYTES && data.byteLength / deflateSync(data, { level: LEVEL }).byteLength > options.maxRatio;
        tree[name] = [data, { level: store ? 0 : LEVEL, mtime }];
    }
    return zipSync(tree);
}

// ─── Reading ────────────────────────────────────────────────────────

export interface ZipLimits {
    maxEntries: number;
    maxEntryBytes: number;
    maxTotalBytes: number;
    maxRatio: number;
}

/** Below this declared size an entry's compression ratio is not judged: the total bounds it. */
export const RATIO_EXEMPT_BYTES = 64 * 1024;

export const ZIP_REFUSAL_REASONS = [
    'NOT_A_ZIP',
    'ZIP64_UNSUPPORTED',
    'MULTI_DISK',
    'TOO_MANY_ENTRIES',
    'ENTRY_NAME_UNSAFE',
    'ENTRY_DUPLICATE',
    'ENTRY_ENCRYPTED',
    'ENTRY_METHOD_UNSUPPORTED',
    'ENTRY_TOO_LARGE',
    'ARCHIVE_TOO_LARGE',
    'ENTRY_RATIO',
    'ENTRY_CORRUPT',
] as const;
export type ZipRefusalReason = (typeof ZIP_REFUSAL_REASONS)[number];

export class ZipRefusal extends Error {
    constructor(
        readonly reason: ZipRefusalReason,
        /** The entry's name, when the refusal is about one (already checked safe to show, or omitted). */
        readonly entry?: string,
    ) {
        super(`zip refused: ${reason}`);
        this.name = 'ZipRefusal';
    }
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;
const MAX_NAME_LENGTH = 255;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Is this entry name safe to treat as a relative path? (`/`-separated, no escape, no control.) */
export function isSafeEntryName(name: string): boolean {
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) return false;
    if (/[\u0000-\u001f\u007f\\:]/.test(name)) return false;
    if (name.startsWith('/')) return false;
    const segments = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/');
    return segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

function findEndOfCentralDirectory(buf: Buffer): number {
    const lowest = Math.max(0, buf.length - EOCD_SIZE - MAX_COMMENT);
    for (let i = buf.length - EOCD_SIZE; i >= lowest; i--) {
        if (buf.readUInt32LE(i) === SIG_EOCD && i + EOCD_SIZE + buf.readUInt16LE(i + 20) === buf.length) return i;
    }
    return -1;
}

interface CentralEntry {
    name: string;
    flags: number;
    method: number;
    crc: number;
    compressedSize: number;
    size: number;
    localOffset: number;
    rawName: Buffer;
}

/**
 * Every file entry of the archive, by name, inflated and checked; directory
 * entries (a name ending in `/`) are left out. Throws `ZipRefusal`.
 */
export function readZip(bytes: Uint8Array, limits: ZipLimits): Map<string, Uint8Array> {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buf.length < EOCD_SIZE) throw new ZipRefusal('NOT_A_ZIP');
    const eocd = findEndOfCentralDirectory(buf);
    if (eocd < 0) throw new ZipRefusal('NOT_A_ZIP');
    if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) throw new ZipRefusal('ZIP64_UNSUPPORTED');

    const disk = buf.readUInt16LE(eocd + 4);
    const directoryDisk = buf.readUInt16LE(eocd + 6);
    const entriesOnDisk = buf.readUInt16LE(eocd + 8);
    const entryCount = buf.readUInt16LE(eocd + 10);
    const directorySize = buf.readUInt32LE(eocd + 12);
    const directoryOffset = buf.readUInt32LE(eocd + 16);
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new ZipRefusal('ZIP64_UNSUPPORTED');
    if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) throw new ZipRefusal('MULTI_DISK');
    if (entryCount > limits.maxEntries) throw new ZipRefusal('TOO_MANY_ENTRIES');
    if (directoryOffset + directorySize > eocd) throw new ZipRefusal('NOT_A_ZIP');

    // Pass 1: the central directory — names, flags, methods and declared
    // sizes, every bound checked before anything is inflated.
    const entries: CentralEntry[] = [];
    const seen = new Set<string>();
    let total = 0;
    let at = directoryOffset;
    for (let i = 0; i < entryCount; i++) {
        if (at + CENTRAL_SIZE > directoryOffset + directorySize || buf.readUInt32LE(at) !== SIG_CENTRAL) throw new ZipRefusal('NOT_A_ZIP');
        const flags = buf.readUInt16LE(at + 8);
        const method = buf.readUInt16LE(at + 10);
        const crc = buf.readUInt32LE(at + 16);
        const compressedSize = buf.readUInt32LE(at + 20);
        const size = buf.readUInt32LE(at + 24);
        const nameLength = buf.readUInt16LE(at + 28);
        const extraLength = buf.readUInt16LE(at + 30);
        const commentLength = buf.readUInt16LE(at + 32);
        const localOffset = buf.readUInt32LE(at + 42);
        const end = at + CENTRAL_SIZE + nameLength + extraLength + commentLength;
        if (end > directoryOffset + directorySize) throw new ZipRefusal('NOT_A_ZIP');
        const rawName = buf.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength);
        const name = rawName.toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1');
        at = end;

        if (!isSafeEntryName(name)) throw new ZipRefusal('ENTRY_NAME_UNSAFE');
        if (seen.has(name)) throw new ZipRefusal('ENTRY_DUPLICATE', name);
        seen.add(name);
        if (name.endsWith('/')) continue;
        if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) throw new ZipRefusal('ENTRY_ENCRYPTED', name);
        if (method !== METHOD_STORED && method !== METHOD_DEFLATE) throw new ZipRefusal('ENTRY_METHOD_UNSUPPORTED', name);
        if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipRefusal('ZIP64_UNSUPPORTED');
        if (size > limits.maxEntryBytes) throw new ZipRefusal('ENTRY_TOO_LARGE', name);
        total += size;
        if (total > limits.maxTotalBytes) throw new ZipRefusal('ARCHIVE_TOO_LARGE');
        if (size > RATIO_EXEMPT_BYTES && (compressedSize === 0 || size / compressedSize > limits.maxRatio)) throw new ZipRefusal('ENTRY_RATIO', name);
        if (method === METHOD_STORED && compressedSize !== size) throw new ZipRefusal('ENTRY_CORRUPT', name);
        entries.push({ name, flags, method, crc, compressedSize, size, localOffset, rawName });
    }

    // Pass 2: each entry's data, inflated no further than its declared size.
    const out = new Map<string, Uint8Array>();
    for (const e of entries) {
        const local = e.localOffset;
        if (local + LOCAL_SIZE > directoryOffset || buf.readUInt32LE(local) !== SIG_LOCAL) throw new ZipRefusal('ENTRY_CORRUPT', e.name);
        const nameLength = buf.readUInt16LE(local + 26);
        const extraLength = buf.readUInt16LE(local + 28);
        const localName = buf.subarray(local + LOCAL_SIZE, local + LOCAL_SIZE + nameLength);
        if (!localName.equals(e.rawName)) throw new ZipRefusal('ENTRY_CORRUPT', e.name);
        const start = local + LOCAL_SIZE + nameLength + extraLength;
        const end = start + e.compressedSize;
        if (end > directoryOffset) throw new ZipRefusal('ENTRY_CORRUPT', e.name);
        const data = buf.subarray(start, end);
        let content: Buffer;
        if (e.method === METHOD_STORED) {
            content = Buffer.from(data);
        } else {
            try {
                content = inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) });
            } catch {
                throw new ZipRefusal('ENTRY_CORRUPT', e.name);
            }
        }
        if (content.length !== e.size || crc32(content) !== e.crc) throw new ZipRefusal('ENTRY_CORRUPT', e.name);
        out.set(e.name, new Uint8Array(content.buffer, content.byteOffset, content.byteLength));
    }
    return out;
}
