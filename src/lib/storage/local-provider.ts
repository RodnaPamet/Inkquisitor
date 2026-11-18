/**
 * Local Filesystem Storage Provider
 *
 * Files under FILE_STORAGE_ROOT, written atomically (exclusive temp file, then
 * rename) with a streaming SHA-256 and size cap. The development default.
 *
 * Lifted from inflect-compliance's `src/lib/storage/local-provider.ts`; the
 * root moved from UPLOAD_DIR to FILE_STORAGE_ROOT with an OS-temp default.
 */
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { env } from '@/env';
import { SIGNED_UPLOAD_URL_TTL_SECONDS } from './signed-url-policy';
import type {
    StorageProvider,
    WriteResult,
    WriteOptions,
    HeadResult,
    SignedUploadTarget,
} from './types';

/** Development default: a private directory under the OS temp dir. */
export const DEFAULT_FILE_STORAGE_ROOT = path.join(os.tmpdir(), 'inkquisitor-uploads');

/** Read per call, so a test can point the provider at its own directory. */
function storageRoot(): string {
    return env.FILE_STORAGE_ROOT || DEFAULT_FILE_STORAGE_ROOT;
}
const DEFAULT_MAX_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Resolve absolute path safely under FILE_STORAGE_ROOT. Throws on traversal.
 */
function resolveStoragePath(pathKey: string): string {
    const root = path.resolve(storageRoot());
    const target = path.resolve(root, pathKey);
    if (!target.startsWith(root + path.sep) && target !== root) {
        throw new Error('Path traversal detected');
    }
    return target;
}

export class LocalStorageProvider implements StorageProvider {
    readonly name = 'local' as const;

    async write(pathKey: string, source: Readable | Buffer, opts?: WriteOptions): Promise<WriteResult> {
        const finalPath = resolveStoragePath(pathKey);
        const dir = path.dirname(finalPath);
        await fs.mkdir(dir, { recursive: true });

        // Temp file: a 128-bit-random suffix, written below with `wx`
        // (exclusive create — O_EXCL, so the open FAILS rather than
        // follows an attacker-planted symlink) and mode 0o600 (so it
        // is owner-readable only). Exclusive + private temp-file
        // creation is the `js/insecure-temporary-file` mitigation —
        // the default storage root can be `/tmp/uploads` in dev.
        const tmpPath = finalPath + '.tmp.' + crypto.randomUUID();
        const hash = crypto.createHash('sha256');
        const maxSize = opts?.maxSizeBytes ?? DEFAULT_MAX_SIZE;
        let sizeBytes = 0;

        try {
            if (Buffer.isBuffer(source)) {
                hash.update(source);
                sizeBytes = source.length;
                if (sizeBytes > maxSize) {
                    throw new Error(`File size exceeds maximum allowed (${maxSize} bytes)`);
                }
                await fs.writeFile(tmpPath, source, { flag: 'wx', mode: 0o600 });
            } else {
                const writeStream = createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 });
                await pipeline(
                    source,
                    async function* (src) {
                        for await (const chunk of src) {
                            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                            hash.update(buf);
                            sizeBytes += buf.length;
                            if (sizeBytes > maxSize) {
                                throw new Error(`File size exceeds maximum allowed (${maxSize} bytes)`);
                            }
                            yield buf;
                        }
                    },
                    writeStream,
                );
            }

            // Atomic rename
            await fs.rename(tmpPath, finalPath);

            return {
                sha256: hash.digest('hex'),
                sizeBytes,
            };
        } catch (err) {
            try { await fs.unlink(tmpPath); } catch { /* ignore cleanup failure */ }
            throw err;
        }
    }

    readStream(pathKey: string): Readable {
        const absPath = resolveStoragePath(pathKey);
        return createReadStream(absPath);
    }

    async createSignedDownloadUrl(pathKey: string): Promise<string> {
        // Local provider: a file-serve API path. The route that serves it (and
        // checks the caller's workspace) arrives with the first upload feature.
        return `/api/files/${encodeURIComponent(pathKey)}`;
    }

    async createSignedUploadUrl(pathKey: string): Promise<SignedUploadTarget> {
        // Local provider: direct uploads go through the API, not presigned URLs
        return {
            url: `/api/files/upload?key=${encodeURIComponent(pathKey)}`,
            method: 'PUT',
            expiresIn: SIGNED_UPLOAD_URL_TTL_SECONDS,
        };
    }

    async head(pathKey: string): Promise<HeadResult> {
        const absPath = resolveStoragePath(pathKey);
        const stat = await fs.stat(absPath);
        return {
            sizeBytes: stat.size,
            lastModified: stat.mtime,
        };
    }

    async delete(pathKey: string): Promise<void> {
        const absPath = resolveStoragePath(pathKey);
        try {
            await fs.unlink(absPath);
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
    }

    async copy(srcKey: string, destKey: string): Promise<void> {
        const srcPath = resolveStoragePath(srcKey);
        const destPath = resolveStoragePath(destKey);
        const destDir = path.dirname(destPath);
        await fs.mkdir(destDir, { recursive: true });
        await fs.copyFile(srcPath, destPath);
    }
}
