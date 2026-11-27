/**
 * A STREAMED, PASSPHRASE-PROTECTED zip (Phase 5.H-a, D36: the full export is one password-protected archive).
 * Server-only.
 *
 * THE ENCRYPTION is WinZip AES — AE-2, AES-256 in CTR mode with an HMAC-SHA1 authentication code per entry, its key
 * derived from the passphrase by PBKDF2 (the format's own parameters: a random 16-byte salt per entry, 1,000
 * iterations) — which 7-Zip, WinZip, macOS's Archive Utility (with 7-Zip or The Unarchiver), libarchive (`bsdtar`)
 * and Python's `pyzipper` read. NEVER the legacy "ZipCrypto" scheme, which is broken: `zipCrypto: false` and
 * `encryptionStrength: 3` are passed on every entry, and `tests/unit/export/encrypted-zip.test.ts` reads every local
 * header back and fails on anything but method 99 with an AE-2, strength-3 extra field — and decrypts each entry with
 * an independent AE-2 reader written over `node:crypto`, so the archive is proved to the specification, not to the
 * library that wrote it.
 *
 * THE LIBRARY is `@zip.js/zip.js` (BSD-3-Clause, credited in NOTICE), the only maintained, permissively licensed
 * JavaScript library that WRITES AES zips (fflate, which the bundle uses, has no encryption). It runs here without
 * Web Workers, on Node's Web Crypto and CompressionStream.
 *
 * STREAMED: entries are added one at a time and written to `readable` as they are compressed and encrypted, so a
 * large workspace is never held whole in memory; the HTTP response reads `readable` and the writer waits on it
 * (backpressure). The passphrase is held only by the writer for the archive's life and is never logged.
 */
import { configure, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';

configure({ useWebWorkers: false });

/** Deflate level: 6 is the zip default's balance of size and time. */
const LEVEL = 6;
/** Every entry's modification time: fixed, so the archive names no moment but the manifest's own. */
const ENTRY_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

export interface EncryptedZip {
    /** The archive's bytes, as they are written. */
    readable: ReadableStream<Uint8Array>;
    addText(name: string, text: string): Promise<void>;
    addBytes(name: string, bytes: Uint8Array, opts?: { store?: boolean }): Promise<void>;
    /** An entry whose content arrives as a stream (a JSONL file written page by page). */
    addStream(name: string, stream: ReadableStream<Uint8Array>): Promise<void>;
    /** Write the central directory and end the stream. */
    close(): Promise<void>;
    /** End the stream with an error (the response is cut; the client sees a failed download, never a partial archive it could mistake for whole). */
    abort(reason: unknown): Promise<void>;
}

/** Chunks the response may hold unread before the writer waits for it. */
const BUFFERED_CHUNKS = 8;

/** The client went away (the response was cancelled): every later write refuses, so the export stops reading. */
export class ExportCancelledError extends Error {
    readonly code = 'EXPORT_CANCELLED';
    constructor() {
        super('The download was cancelled.');
        this.name = 'ExportCancelledError';
    }
}

/**
 * A readable for the response and a writable for the zip writer, joined with backpressure: a write waits while the
 * response holds `BUFFERED_CHUNKS` unread, and refuses once the response is cancelled. `fail` errors the readable.
 */
function joinedPipe(): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; fail(reason: unknown): void } {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let wake: (() => void) | null = null;
    let cancelled = false;
    let ended = false;
    const readable = new ReadableStream<Uint8Array>(
        {
            start(c) {
                controller = c;
            },
            pull() {
                wake?.();
                wake = null;
            },
            cancel() {
                cancelled = true;
                wake?.();
                wake = null;
            },
        },
        { highWaterMark: BUFFERED_CHUNKS },
    );
    const writable = new WritableStream<Uint8Array>({
        async write(chunk) {
            if (cancelled) throw new ExportCancelledError();
            controller.enqueue(chunk);
            while (!cancelled && (controller.desiredSize ?? 1) <= 0) await new Promise<void>((resolve) => (wake = resolve));
            if (cancelled) throw new ExportCancelledError();
        },
        close() {
            if (!cancelled && !ended) {
                ended = true;
                controller.close();
            }
        },
    });
    return {
        readable,
        writable,
        fail(reason) {
            if (ended || cancelled) return;
            ended = true;
            controller.error(reason);
        },
    };
}

export function createEncryptedZip(passphrase: string): EncryptedZip {
    const pipe = joinedPipe();
    const writer = new ZipWriter(pipe.writable, {
        password: passphrase,
        encryptionStrength: 3,
        zipCrypto: false,
        level: LEVEL,
        lastModDate: ENTRY_DATE,
        extendedTimestamp: false,
        useWebWorkers: false,
    });
    const entry = (store?: boolean) => ({ password: passphrase, encryptionStrength: 3 as const, zipCrypto: false, level: store ? 0 : LEVEL, lastModDate: ENTRY_DATE, extendedTimestamp: false });
    return {
        readable: pipe.readable,
        async addText(name, text) {
            await writer.add(name, new TextReader(text), entry());
        },
        async addBytes(name, bytes, opts) {
            await writer.add(name, new Uint8ArrayReader(bytes), entry(opts?.store));
        },
        async addStream(name, stream) {
            await writer.add(name, stream, entry());
        },
        async close() {
            await writer.close();
        },
        async abort(reason) {
            pipe.fail(reason);
        },
    };
}
