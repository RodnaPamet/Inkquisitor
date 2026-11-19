/**
 * A refused stream write leaves no temp file, however the write stream's
 * asynchronous open and the refusal interleave. The cap can throw before the
 * stream has opened its file; cleanup that unlinks without waiting for the
 * stream to close then misses a file the open creates a moment later. Many
 * concurrent refusals make that interleaving likely on any machine.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

let root: string;

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-storage-race-'));
    process.env.FILE_STORAGE_ROOT = root;
    process.env.STORAGE_PROVIDER = 'local';
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it('leaves no temp file behind when many over-cap streams are refused at once', async () => {
    jest.resetModules();
    const { getStorageProvider, buildWorkspaceObjectKey } = await import('@/lib/storage');
    const storage = getStorageProvider();
    const writes = Array.from({ length: 200 }, (_, i) =>
        storage
            .write(buildWorkspaceObjectKey('ws-race', 'imports', `big-${i}.bin`), Readable.from([Buffer.alloc(6, 1), Buffer.alloc(6, 2)]), {
                maxSizeBytes: 10,
            })
            .then(
                () => 'written',
                (e: Error) => e.message,
            ),
    );
    const outcomes = await Promise.all(writes);
    expect(outcomes.every((o) => /exceeds/.test(o))).toBe(true);
    // Let any open the cleanup raced finish before looking.
    await new Promise((r) => setTimeout(r, 200));
    // Keys carry date folders, so look for FILES anywhere under the workspace.
    const dir = path.join(root, 'workspaces', 'ws-race');
    const files = fs.existsSync(dir)
        ? (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[]).filter((d) => d.isFile()).map((d) => d.name)
        : [];
    expect(files).toEqual([]);
});
