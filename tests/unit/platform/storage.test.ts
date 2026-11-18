/**
 * Storage: workspace-scoped keys, the local provider against a real temp
 * directory, the upload limits and the antivirus download gate.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import {
    assertWorkspaceKey,
    buildWorkspaceObjectKey,
    getStorageProvider,
    isAllowedMime,
    isAllowedSize,
    parseWorkspaceKey,
    resetStorageProviders,
    sanitizeFileName,
    FILE_MAX_SIZE_DEFAULT_BYTES,
} from '@/lib/storage';
import { isDownloadAllowed, scanBuffer } from '@/lib/storage/av-scan';
import { AppError } from '@/lib/errors/types';

let root: string;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-storage-'));
    process.env.FILE_STORAGE_ROOT = root;
    delete process.env.STORAGE_PROVIDER;
    resetStorageProviders();
});
afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FILE_STORAGE_ROOT;
    delete process.env.AV_SCAN_MODE;
    delete process.env.CLAMAV_HOST;
});

describe('object keys', () => {
    it('builds a workspace-scoped, dated, unique key with a sanitised name', () => {
        const key = buildWorkspaceObjectKey('ws1', 'imports', '../../etc/passwd', { date: new Date('2026-03-04T00:00:00Z') });
        expect(key).toMatch(/^workspaces\/ws1\/imports\/2026\/03\/[0-9a-f-]{36}_passwd$/);
        expect(parseWorkspaceKey(key)).toEqual({ workspaceId: 'ws1', domain: 'imports' });
        expect(buildWorkspaceObjectKey('ws1', 'imports', 'a.md')).not.toBe(buildWorkspaceObjectKey('ws1', 'imports', 'a.md'));
    });

    it('refuses a key from another workspace, and a traversal', () => {
        const key = buildWorkspaceObjectKey('ws1', 'exports', 'bible.zip');
        expect(() => assertWorkspaceKey(key, 'ws1')).not.toThrow();
        expect(() => assertWorkspaceKey(key, 'ws2')).toThrow(AppError);
        expect(() => assertWorkspaceKey('workspaces/ws1/../ws2/x', 'ws1')).toThrow(AppError);
        expect(() => buildWorkspaceObjectKey('ws1/../ws2', 'imports', 'x')).toThrow(AppError);
    });

    it('sanitises control characters and quotes', () => {
        expect(sanitizeFileName('a\u0000b"c<d>.md')).toBe('a_b_c_d_.md');
    });
});

describe('local provider', () => {
    it('defaults to local and round-trips a stream with its sha256', async () => {
        const storage = getStorageProvider();
        expect(storage.name).toBe('local');
        const key = buildWorkspaceObjectKey('ws1', 'attachments', 'note.txt');
        const content = Buffer.from('chapter notes');
        const result = await storage.write(key, Readable.from([content]));
        expect(result).toEqual({ sha256: crypto.createHash('sha256').update(content).digest('hex'), sizeBytes: content.length });
        const chunks: Buffer[] = [];
        for await (const c of storage.readStream(key)) chunks.push(c as Buffer);
        expect(Buffer.concat(chunks).toString()).toBe('chapter notes');
        expect((await storage.head(key)).sizeBytes).toBe(content.length);
        await storage.delete(key);
        await expect(storage.head(key)).rejects.toThrow();
        await expect(storage.delete(key)).resolves.toBeUndefined();
    });

    it('enforces the size cap and leaves no partial file', async () => {
        const storage = getStorageProvider();
        const key = buildWorkspaceObjectKey('ws1', 'imports', 'big.bin');
        await expect(storage.write(key, Buffer.alloc(11), { maxSizeBytes: 10 })).rejects.toThrow(/exceeds/);
        const dir = path.join(root, path.dirname(key));
        expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    });

    it('a STREAM over the cap is refused mid-write, and its temp file is removed', async () => {
        const storage = getStorageProvider();
        const key = buildWorkspaceObjectKey('ws1', 'imports', 'big-stream.bin');
        // Two chunks: the first is written to the temp file, the second
        // crosses the cap, so a partial `.tmp.` file exists when it throws.
        const source = Readable.from([Buffer.alloc(6, 1), Buffer.alloc(6, 2)]);
        await expect(storage.write(key, source, { maxSizeBytes: 10 })).rejects.toThrow(/exceeds/);
        const dir = path.join(root, path.dirname(key));
        const left = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        expect(left.filter((f) => f.includes('.tmp.'))).toEqual([]);
        expect(left).toEqual([]);
    });

    it('refuses a path that escapes the storage root', async () => {
        await expect(getStorageProvider().write('../escape.txt', Buffer.from('x'))).rejects.toThrow(/traversal/);
    });
});

describe('upload limits', () => {
    it('defaults to 50 MB and the author file types', () => {
        expect(isAllowedSize(FILE_MAX_SIZE_DEFAULT_BYTES)).toBe(true);
        expect(isAllowedSize(FILE_MAX_SIZE_DEFAULT_BYTES + 1)).toBe(false);
        expect(isAllowedSize(0)).toBe(false);
        expect(isAllowedMime('text/markdown')).toBe(true);
        expect(isAllowedMime('application/x-msdownload')).toBe(false);
    });
});

describe('antivirus download gate', () => {
    it('strict is the default: a pending file is blocked, a clean one is not', () => {
        expect(isDownloadAllowed('PENDING')).toBe(false);
        expect(isDownloadAllowed(undefined)).toBe(false);
        expect(isDownloadAllowed('CLEAN')).toBe(true);
    });

    it('an infected file is never downloadable, whatever the mode', () => {
        for (const mode of ['strict', 'permissive', 'disabled']) {
            process.env.AV_SCAN_MODE = mode;
            expect(isDownloadAllowed('INFECTED')).toBe(false);
        }
    });

    it('permissive lets a pending file through', () => {
        process.env.AV_SCAN_MODE = 'permissive';
        expect(isDownloadAllowed('PENDING')).toBe(true);
    });

    it('with no ClamAV configured a scan is an ERROR, not a clean bill, unless scanning is disabled', async () => {
        expect((await scanBuffer(Buffer.from('x'))).status).toBe('ERROR');
        process.env.AV_SCAN_MODE = 'disabled';
        expect((await scanBuffer(Buffer.from('x'))).status).toBe('CLEAN');
    });
});
