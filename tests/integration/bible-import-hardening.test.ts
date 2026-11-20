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

/**
 * The parse of each file's frontmatter, observed: each call records the event
 * loop turn it ran in (the "yields between files" case counts them). The real
 * parser runs every time.
 */
const mockParseTurns: number[] = [];
const mockTurnOf: { current: (() => number) | null } = { current: null };
jest.mock('@/lib/bible/bundle-format', () => {
    const actual = jest.requireActual('@/lib/bible/bundle-format');
    return {
        ...actual,
        parseYamlFrontmatter: (source: string) => {
            if (mockTurnOf.current) mockParseTurns.push(mockTurnOf.current());
            return actual.parseYamlFrontmatter(source);
        },
    };
});

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
    // Fourteen ~1.9 MB files, past 24 MiB together. Stored, not deflated
    // (writeZip with the import's own ratio), so no entry trips the bomb ratio
    // first, and the archive costs no slow compression of random bytes: the
    // refusal reads only the declared sizes, before anything is inflated.
    const filler = 'x'.repeat(1_870_000);
    const many = new Map<string, string>([['manifest.json', manifest]]);
    for (let i = 0; i < 14; i++) many.set(`theme/t${i}.md`, `---\nkind: THEME\nname: T${i}\nslug: t${i}\nstatus: DRAFT\nsummary: "${filler}"\n---\n`);
    expect(await problemsOf(importBibleBundle(ctx, bookId, writeZip(many, { maxRatio: BUNDLE_ZIP_LIMITS.maxRatio }), {}, clean))).toEqual([{ path: '', reason: 'ARCHIVE_TOO_LARGE' }]);
});

it('yields between files: a bundle never holds the event loop for more than one file\'s parse', async () => {
    // 16 files of dense YAML structure under a key no element has: each is
    // refused (one UNKNOWN_KEY) only after it is parsed, so every file IS
    // parsed. Random keys, so the files do not compress past the bomb ratio
    // and get refused unparsed.
    const dense = () => Array.from({ length: 300 }, () => `  k${randomBytes(5).toString('hex')}: [a, {b: 1}]`).join('\n');
    const files = new Map<string, string>([['manifest.json', manifest]]);
    for (let i = 0; i < 16; i++) files.set(`theme/d${i}.md`, `---\nkind: THEME\nname: D${i}\nslug: d${i}\nstatus: DRAFT\nextra:\n${dense()}\n---\n`);
    const bytes = writeZip(files);
    // Counted, not timed: a chain of setImmediate callbacks counts the event
    // loop's turns (each turn of the check phase runs exactly one link), and
    // each parse records the count it ran at. Two parses in one turn mean the
    // import ran from one file into the next without letting the loop serve
    // anything else in between.
    let turns = 0;
    let ticking = true;
    const tick = () => {
        turns++;
        if (ticking) setImmediate(tick);
    };
    setImmediate(tick);
    mockParseTurns.length = 0;
    mockTurnOf.current = () => turns;
    let problems: Array<{ path: string; reason: string }>;
    try {
        problems = await problemsOf(importBibleBundle(ctx, bookId, bytes, {}, clean));
    } finally {
        ticking = false;
        mockTurnOf.current = null;
    }
    // Refused for what each file says, so every file WAS parsed.
    expect(problems).toHaveLength(16);
    expect(new Set(problems.map((p) => p.reason))).toEqual(new Set(['UNKNOWN_KEY']));
    expect(mockParseTurns).toHaveLength(16);
    // The loop turned between every two files' parses.
    for (let i = 1; i < mockParseTurns.length; i++) expect(mockParseTurns[i]).toBeGreaterThan(mockParseTurns[i - 1]);
});
