/**
 * The bible load test's fixture (Phase 1.H, item 6): a book of N elements and
 * M versions, seeded through the FAST path — `createMany` inside the
 * workspace's own context, so every author-text column is sealed by the
 * encryption extension exactly as the product seals it, without going
 * through the usecases one save at a time. Fields fill about half of each
 * template; relations link each element to a few others; versions are spread
 * over the elements, the first element holding a long history of its own.
 *
 * Shared by `tests/integration/bible-load.test.ts` and `npm run test:load`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createBook } from '@/app-layer/usecases/books';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { encodeFieldValue } from '@/lib/bible/field-values';
import { BIBLE_KINDS, type BibleKind } from '@/lib/bible/kinds';
import { buildSnapshot, serialiseSnapshot } from '@/lib/bible/snapshot';
import { getTemplate } from '@/lib/bible/templates';

export interface LoadBook {
    bookId: string;
    /** The element with the long history (the element page's worst case). */
    hotElementId: string;
    elementIds: string[];
    elements: number;
    versions: number;
}

const SEED_TX = { timeout: 600_000 };

/** A field value of the field's type, about as long as an author writes. */
function valueFor(type: string, options: ReadonlyArray<{ value: string }>, i: number): unknown {
    switch (type) {
        case 'richtext':
            return `<p>Paragraph ${i} of considered prose about the matter at hand, with a clause or two more.</p><p>A second paragraph.</p>`;
        case 'list':
            return ['one', 'two', 'three'];
        case 'choice':
            return options[i % options.length]?.value ?? null;
        case 'scale':
            return (i % 5) + 1;
        default:
            return `A line of text ${i}`;
    }
}

export async function seedLoadBook(ctx: WorkspaceRequestContext, options: { elements: number; versions: number }): Promise<LoadBook> {
    const { elements, versions } = options;
    const book = await createBook(ctx, { title: `Load ${randomBytes(3).toString('hex')}` });
    const kinds = BIBLE_KINDS.filter((k) => k !== 'CUSTOM') as BibleKind[];
    const rows = Array.from({ length: elements }, (_, i) => {
        const kind = kinds[i % kinds.length];
        return { id: `ld${randomBytes(10).toString('hex')}`, kind, name: `${kind.toLowerCase()} entry ${String(i).padStart(5, '0')}`, slug: `entry-${i}` };
    });

    await runInWorkspaceContext(
        ctx,
        async (db) => {
            for (let i = 0; i < rows.length; i += 1_000) {
                await db.bibleElement.createMany({
                    data: rows.slice(i, i + 1_000).map((r) => ({ ...r, workspaceId: ctx.workspaceId, bookId: book.id, summary: `Summary of ${r.name}` })),
                });
            }
            const fields: Array<{ workspaceId: string; elementId: string; key: string; value: string; order: number }> = [];
            rows.forEach((r, i) => {
                for (const f of getTemplate(r.kind).fields.filter((_, n) => n % 2 === 0)) {
                    const v = valueFor(f.type, f.type === 'choice' ? f.options : [], i);
                    if (v !== null) fields.push({ workspaceId: ctx.workspaceId, elementId: r.id, key: f.key, value: encodeFieldValue(v as never), order: f.order });
                }
            });
            for (let i = 0; i < fields.length; i += 2_000) await db.bibleField.createMany({ data: fields.slice(i, i + 2_000) });
            const relations = rows.flatMap((r, i) =>
                [1, 2, 3].filter((d) => i + d < rows.length).map((d) => ({ workspaceId: ctx.workspaceId, bookId: book.id, fromElementId: r.id, toElementId: rows[i + d].id, type: 'related_to', symmetric: true })),
            );
            for (let i = 0; i < relations.length; i += 2_000) await db.bibleRelation.createMany({ data: relations.slice(i, i + 2_000) });

            // Versions: a tenth on the first element, the rest spread evenly.
            const hot = Math.max(1, Math.floor(versions / 10));
            const perElement = new Map<string, number>(rows.map((r) => [r.id, 0]));
            perElement.set(rows[0].id, hot);
            for (let n = 0; n < versions - hot; n++) {
                const r = rows[n % rows.length];
                perElement.set(r.id, (perElement.get(r.id) ?? 0) + 1);
            }
            const batch: Array<Record<string, unknown>> = [];
            const flush = async () => {
                if (batch.length === 0) return;
                await db.bibleEntryVersion.createMany({ data: batch.splice(0) as never });
            };
            for (const r of rows) {
                const snapshot = serialiseSnapshot(
                    buildSnapshot({ element: { kind: r.kind, name: r.name, slug: r.slug, status: 'DRAFT', summary: `Summary of ${r.name}`, customLabel: null }, fields: [] }),
                );
                for (let v = 1; v <= (perElement.get(r.id) ?? 0); v++) {
                    batch.push({ workspaceId: ctx.workspaceId, bookId: book.id, elementId: r.id, versionNumber: v, snapshot, changeSummary: null, source: 'MANUAL', authorId: ctx.userId });
                    if (batch.length >= 2_000) await flush();
                }
            }
            await flush();
        },
        SEED_TX,
    );
    return { bookId: book.id, hotElementId: rows[0].id, elementIds: rows.map((r) => r.id), elements, versions };
}

/** The p50 and p95 of `samples` (milliseconds). */
export function percentiles(samples: readonly number[]): { p50: number; p95: number; max: number } {
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
    return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

/** Run `fn` `warmup` times unmeasured, then `runs` times, each timed. */
export async function measure(fn: () => Promise<unknown>, runs: number, warmup = 3): Promise<{ p50: number; p95: number; max: number }> {
    for (let i = 0; i < warmup; i++) await fn();
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) {
        const t = performance.now();
        await fn();
        samples.push(performance.now() - t);
    }
    return percentiles(samples);
}

/** What the continuity load test seeds on top of a load book (Phase 4.H-b, roadmap 4.H item 6). */
export interface LoadFacts {
    facts: number;
    contradictions: number;
    noLongerStated: number;
}

const PREDICATES = ['AGE', 'LOCATION', 'OCCUPATION', 'WANT', 'ROLE', 'KNOWLEDGE', 'TRAIT', 'OTHER'] as const;

/**
 * `facts` live bible facts spread over the load book's elements (each an element's own fact, drawn from its newest
 * version), with a twentieth of them (at least 150 pairs) in pending contradictions, a fiftieth no longer stated and a fiftieth decided,
 * 150 threads, 100 pending thread proposals and a finished nightly run: the Continuity page's every list full and
 * past its bound. Through the FAST path (`createMany` in the workspace's context: every author-text column sealed as
 * the product seals it).
 */
export async function seedLoadFacts(ctx: WorkspaceRequestContext, book: LoadBook, facts: number): Promise<LoadFacts> {
    const tag = randomBytes(4).toString('hex');
    return runInWorkspaceContext(
        ctx,
        async (db) => {
            const versions = await db.bibleEntryVersion.findMany({ where: { workspaceId: ctx.workspaceId, bookId: book.bookId }, select: { id: true, elementId: true, versionNumber: true }, take: book.versions });
            const newest = new Map<string, { id: string; n: number }>();
            for (const v of versions) if ((newest.get(v.elementId)?.n ?? 0) < v.versionNumber) newest.set(v.elementId, { id: v.id, n: v.versionNumber });
            const owners = book.elementIds.filter((id) => newest.has(id));
            const ids: string[] = [];
            const statedAt = Date.now() - 86_400_000;
            for (let i = 0; i < facts; i += 1_000) {
                const data = Array.from({ length: Math.min(1_000, facts - i) }, (_, k) => {
                    const n = i + k;
                    const owner = owners[n % owners.length];
                    const id = `lf${tag}${String(n).padStart(6, '0')}`;
                    ids.push(id);
                    const statement = `Entry ${n} holds that the river runs high in the season of the ${n % 12}th moon.`;
                    return {
                        id,
                        workspaceId: ctx.workspaceId,
                        sourceKind: 'BIBLE_VERSION' as const,
                        bookId: book.bookId,
                        elementId: owner,
                        bibleVersionId: newest.get(owner)!.id,
                        automatic: true,
                        dedupeKey: createHash('sha256').update(`load-${tag}-${n}`).digest('hex'),
                        position: n,
                        subjectName: `Subject ${n % owners.length}`,
                        subjectElementId: owner,
                        predicate: PREDICATES[n % PREDICATES.length],
                        objectLiteral: n % 3 === 0 ? `value ${n}` : null,
                        statement,
                        quote: statement,
                        quoteStart: 0,
                        quoteEnd: statement.length,
                        status: 'CONFIRMED' as const,
                        statedAt: new Date(statedAt + n),
                        decidedAt: new Date(statedAt + n),
                    };
                });
                await db.storyFact.createMany({ data });
            }
            // A twentieth, and never fewer than the page's list holds (so the list is past its bound at any size).
            const contradictions = Math.max(150, Math.floor(facts / 20));
            const pairs = Array.from({ length: contradictions }, (_, i) => ({ workspaceId: ctx.workspaceId, bookId: book.bookId, factId: ids[2 * i], newerFactId: ids[2 * i + 1], reason: 'CONTRADICTED', basis: 'RULE', kind: 'VALUE' }));
            const noLongerStated = Math.floor(facts / 50);
            const gone = Array.from({ length: noLongerStated }, (_, i) => ({ workspaceId: ctx.workspaceId, bookId: book.bookId, factId: ids[facts - 1 - i], newerFactId: null, reason: 'NO_LONGER_STATED', basis: 'TEXT', kind: null }));
            const decided = Array.from({ length: Math.floor(facts / 50) }, (_, i) => ({ workspaceId: ctx.workspaceId, bookId: book.bookId, factId: ids[2 * contradictions + 2 * i], newerFactId: ids[2 * contradictions + 2 * i + 1], reason: 'CONTRADICTED', basis: 'RULE', kind: 'VALUE', status: 'REJECTED', decidedAt: new Date() }));
            for (const rows of [pairs, gone, decided]) for (let i = 0; i < rows.length; i += 1_000) await db.storyFactProposal.createMany({ data: rows.slice(i, i + 1_000) });
            await db.storyThread.createMany({ data: Array.from({ length: 150 }, (_, i) => ({ workspaceId: ctx.workspaceId, bookId: book.bookId, kind: (['PROMISE', 'CLUE', 'OPEN_QUESTION'] as const)[i % 3], title: `Thread ${i} of the load book`, state: 'OPEN', subjectElementId: owners[i % owners.length] })) });
            await db.storyThreadProposal.createMany({
                data: Array.from({ length: 100 }, (_, i) => ({ workspaceId: ctx.workspaceId, bookId: book.bookId, op: 'NEW_THREAD', kind: 'PROMISE', title: `Proposed thread ${i}`, proposedState: 'OPEN', quote: `A quote ${i}`, quoteStart: 0, quoteEnd: 9, subjectElementId: owners[i % owners.length], bibleVersionId: newest.get(owners[i % owners.length])!.id, dedupeKey: createHash('sha256').update(`load-thread-${tag}-${i}`).digest('hex') })),
            });
            await db.continuityCheck.create({ data: { workspaceId: ctx.workspaceId, bookId: book.bookId, coveredThrough: new Date(), lastRunAt: new Date(), lastOutcome: 'OK' } });
            await db.continuityRun.create({ data: { workspaceId: ctx.workspaceId, bookId: book.bookId, status: 'DONE', outcome: 'OK', factsRead: Math.min(facts, 4_000), metrics: { factsCut: facts > 4_000 }, finishedAt: new Date() } });
            return { facts, contradictions, noLongerStated };
        },
        SEED_TX,
    );
}
