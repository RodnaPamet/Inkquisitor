/**
 * The bundle import's CPU bounds (Phase 1.H, #27 item 1). Parsing YAML is
 * CPU-bound, so:
 *
 *   - a file and the whole bundle are bounded inflated (2 MiB, 24 MiB), and
 *     past either the bundle is refused before a byte is parsed;
 *   - the import yields to the event loop between files, so one import holds
 *     the process for one file's parse at most — never for the whole bundle;
 *   - a mapping's keys are checked for duplicates in linear time (the YAML
 *     library's own check was quadratic; tests/unit/bible/bundle-format.test.ts).
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { importBibleBundle, type ImportDeps } from '@/app-layer/usecases/bible-import';
import { createBook } from '@/app-layer/usecases/books';
import { BUNDLE_ZIP_LIMITS } from '@/app-layer/schemas/bible-transfer';
import { writeZip } from '@/lib/archive/zip';
import type { ScanResult } from '@/lib/storage/av-scan';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const clean: ImportDeps = { scan: async (): Promise<ScanResult> => ({ status: 'CLEAN', engine: 'test', durationMs: 0 }) };
let ctx: ReturnType<typeof workspaceCtx>;
let bookId: string;

beforeAll(async () => {
    ctx = workspaceCtx(await createAccount());
    bookId = (await createBook(ctx, { title: 'Bounded imports' })).id;
});

const manifest = '{"format":"inkquisitor-bible","version":1}\n';

async function problemsOf(p: Promise<unknown>): Promise<Array<{ path: string; reason: string }>> {
    const err = (await p.then(
        () => null,
        (e: unknown) => e,
    )) as { details?: { problems?: Array<{ path: string; reason: string }> } } | null;
    return err?.details?.problems ?? [];
}

it('refuses a file past 2 MiB and a bundle past 24 MiB inflated, before parsing', async () => {
    expect(BUNDLE_ZIP_LIMITS.maxEntryBytes).toBe(2 * 1024 * 1024);
    expect(BUNDLE_ZIP_LIMITS.maxTotalBytes).toBe(24 * 1024 * 1024);
    const big = `---\nkind: THEME\nname: Big\nslug: big\nstatus: DRAFT\nsummary: "${'x'.repeat(BUNDLE_ZIP_LIMITS.maxEntryBytes)}"\n---\n`;
    expect(await problemsOf(importBibleBundle(ctx, bookId, writeZip(new Map([['manifest.json', manifest], ['theme/big.md', big]])), {}, clean))).toEqual([
        { path: 'theme/big.md', reason: 'ENTRY_TOO_LARGE' },
    ]);
    // Incompressible, so no entry trips the bomb ratio first.
    const chunk = randomBytes(1_400_000).toString('base64');
    const many = new Map<string, string>([['manifest.json', manifest]]);
    for (let i = 0; i < 14; i++) many.set(`theme/t${i}.md`, `---\nkind: THEME\nname: T${i}\nslug: t${i}\nstatus: DRAFT\nsummary: "${chunk}"\n---\n`);
    expect(await problemsOf(importBibleBundle(ctx, bookId, writeZip(many), {}, clean))).toEqual([{ path: '', reason: 'ARCHIVE_TOO_LARGE' }]);
});

it('yields between files: a bundle of dense files never holds the event loop for the whole parse', async () => {
    // 16 files of ~130 KB of dense YAML structure under a key no element has:
    // each takes ~0.25 s to parse, the whole ~4 s, and each file is refused
    // (one UNKNOWN_KEY) only after it is parsed, so the parse runs in full.
    // Random keys, so the files do not compress past the bomb ratio and get
    // refused unparsed.
    const dense = () => Array.from({ length: 6_000 }, () => `  k${randomBytes(5).toString('hex')}: [a, {b: 1}]`).join('\n');
    const files = new Map<string, string>([['manifest.json', manifest]]);
    for (let i = 0; i < 16; i++) files.set(`theme/d${i}.md`, `---\nkind: THEME\nname: D${i}\nslug: d${i}\nstatus: DRAFT\nextra:\n${dense()}\n---\n`);
    const bytes = writeZip(files);
    // A 5 ms ticker: the longest gap between two ticks is the longest the loop was held.
    let last = performance.now();
    let longestStallMs = 0;
    const ticker = setInterval(() => {
        const now = performance.now();
        longestStallMs = Math.max(longestStallMs, now - last);
        last = now;
    }, 5);
    const started = performance.now();
    let problems: Array<{ path: string; reason: string }>;
    try {
        problems = await problemsOf(importBibleBundle(ctx, bookId, bytes, {}, clean));
    } finally {
        // One more tick first: a stall that ran to the end is recorded by the tick after it.
        await new Promise((resolve) => setTimeout(resolve, 20));
        clearInterval(ticker);
    }
    const total = performance.now() - started;
    // Refused for what each file says, so every file WAS parsed.
    expect(problems).toHaveLength(16);
    expect(new Set(problems.map((p) => p.reason))).toEqual(new Set(['UNKNOWN_KEY']));
    // The whole parse took far longer than any single stall: the loop ran between files.
    expect(total).toBeGreaterThan(longestStallMs * 3);
    expect(longestStallMs).toBeLessThan(1_000);
});
