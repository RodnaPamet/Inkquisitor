/**
 * Every workspace-scoped table in the live database carries the full RLS
 * set, and the set really isolates.
 *
 *   1. STRUCTURE (tests/helpers/rls-coverage.ts): RLS enabled and forced,
 *      and `workspace_isolation` / `superuser_bypass` EXACTLY as expected —
 *      qual, with_check, permissive, roles and cmd compared to the normalised
 *      expressions in `pg_policies`, not searched for a substring.
 *   2. BEHAVIOUR: for every scoped table, app_user bound to workspace A sees
 *      its own rows, sees none of workspace B's, and cannot insert a row of
 *      B's. A policy the structural check somehow passed would still fail
 *      here.
 *
 * The denominator is the schema, not a list in this file: every model with a
 * `workspaceId` (plus `Workspace`) must be covered, and every other table
 * must be a declared global model.
 *
 * Both checkers are proved against scratch tables: one with no policy, one
 * with an INVERTED policy (`!=`) and one with a VACUOUS policy
 * (`current_setting(...) IS NOT NULL`). If either checker ever stopped
 * detecting those, this suite fails.
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { GLOBAL_MODELS, workspaceScopedModelNames } from '@/lib/db/rls-tripwire';
import { isolationColumn, rlsProblems, type TableRlsFacts } from '../helpers/rls-coverage';
import { seedBible } from '../helpers/bible';
import { seedVectors } from '../helpers/vectors';
import { seedInterview } from '../helpers/interview';
import { seedReconciledRound } from '../helpers/enrichment';
import { seedResearchRun } from '../helpers/research';
import { seedAiCall, seedReservation } from '../helpers/ai-calls';
import { seedStoryMap } from '../helpers/canvas';
import { seedSourceLibrary } from '../helpers/sources';
import { seedFactLayer } from '../helpers/facts';
import { seedContinuity } from '../helpers/continuity';
import { createAccount, workspaceCtx } from '../helpers/workspaces';
import { setBookInterviewDefaults, setWorkspaceInterviewDefaults } from '@/app-layer/usecases/interview-defaults';

afterAll(() => prisma.$disconnect());

async function factsFor(table: string): Promise<TableRlsFacts> {
    const cls = await prisma.$queryRaw<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
        SELECT c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ${table}`;
    if (cls.length === 0) throw new Error(`table ${table} does not exist`);
    const policies = await prisma.$queryRaw<
        Array<{ policyname: string; permissive: string; roles: string[]; cmd: string; qual: string | null; with_check: string | null }>
    >`
        SELECT policyname, permissive, roles::text[] AS roles, cmd, qual, with_check
        FROM pg_policies WHERE schemaname = 'public' AND tablename = ${table}`;
    return {
        table,
        rlsEnabled: cls[0].relrowsecurity,
        rlsForced: cls[0].relforcerowsecurity,
        policies: policies.map((p) => ({ name: p.policyname, permissive: p.permissive, roles: p.roles, cmd: p.cmd, qual: p.qual, withCheck: p.with_check })),
    };
}

const SENTINEL = 'rls-coverage: rollback';

/** As app_user bound to `self`: what of `other`'s rows in `table` leaks, if anything. */
async function isolationLeaks(table: string, self: string, other: string): Promise<string[]> {
    const col = isolationColumn(table);
    const problems: string[] = [];
    const [{ ownRows, otherRows }] = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${self}, true)`;
        return tx.$queryRawUnsafe<Array<{ ownRows: number; otherRows: number }>>(
            `SELECT (SELECT count(*) FROM "${table}" WHERE "${col}" = $1)::int AS "ownRows",
                    (SELECT count(*) FROM "${table}" WHERE "${col}" = $2)::int AS "otherRows"`,
            self,
            other,
        );
    });
    if (ownRows === 0) problems.push(`${table}: app_user cannot see its own workspace's rows (a vacuous control proves nothing)`);
    if (otherRows !== 0) problems.push(`${table}: app_user bound to one workspace sees ${otherRows} row(s) of another`);

    // A row of `other`, copied as the owner (who sees everything) with a fresh
    // id, then inserted as app_user bound to `self`. Always rolled back.
    // A vector of a QUESTION is refused by its source guard before RLS is
    // asked (the question is invisible to `self`: VECTOR_SOURCE_MISSING), so
    // the probe copies a vector of the fixture source, which has no guard.
    // Unordered, LIMIT 1 picked either, and the test failed now and then.
    // A fact linked to an element is refused by its element trigger (STORY_FACT_ELEMENT_FOREIGN, a BEFORE trigger, so
    // before RLS's WITH CHECK): the probe copies an unlinked one (Phase 4.1's bible facts are always linked).
    const sourceFilter =
        table === 'VectorEmbedding'
            ? ` AND "sourceModel" NOT IN ('Question', 'SourceChunk', 'BibleElement', 'StoryFact', 'Answer')`
            : table === 'StoryFact'
              ? ` AND "subjectElementId" IS NULL AND "objectElementId" IS NULL`
              : '';
    const [source] = await prisma.$queryRawUnsafe<Array<{ row: Record<string, unknown> }>>(
        `SELECT row_to_json(t) AS row FROM "${table}" t WHERE "${col}" = $1${sourceFilter} LIMIT 1`,
        other,
    );
    if (!source) {
        problems.push(`${table}: no row of the other workspace to copy (seed one)`);
        return problems;
    }
    const row = { ...source.row };
    if (col !== 'id' && 'id' in row) row.id = `rls-probe-${randomBytes(6).toString('hex')}`;
    if ('slug' in row) row.slug = `rls-probe-${randomBytes(6).toString('hex')}`;
    // Phase 4.2: a thread's (or a proposal's) element is checked by a BEFORE trigger (STORY_THREAD_SUBJECT_FOREIGN),
    // which fires before RLS's WITH CHECK: the probe copies the row without its element, so RLS is what is asked.
    if ((table === 'StoryThread' || table === 'StoryThreadProposal') && 'subjectElementId' in row) row.subjectElementId = null;
    if (table === 'StoryThreadProposal' && 'dedupeKey' in row) row.dedupeKey = randomBytes(32).toString('hex');
    let outcome: 'inserted' | 'refused-by-rls' | string = 'inserted';
    try {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SET LOCAL ROLE app_user`;
            await tx.$executeRaw`SELECT set_config('app.workspace_id', ${self}, true)`;
            await tx.$executeRawUnsafe(`INSERT INTO "${table}" SELECT * FROM json_populate_record(NULL::"${table}", $1::json)`, JSON.stringify(row));
            throw new Error(SENTINEL);
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes(SENTINEL)) outcome = 'inserted';
        else if (/row-level security/.test(message)) outcome = 'refused-by-rls';
        else outcome = `failed for another reason: ${message.split('\n').slice(-1)[0]}`;
    }
    if (outcome !== 'refused-by-rls') problems.push(`${table}: inserting a row of another workspace was not refused by RLS (${outcome})`);
    return problems;
}

const scoped = workspaceScopedModelNames();

let a: Awaited<ReturnType<typeof createAccount>>;
let b: Awaited<ReturnType<typeof createAccount>>;
beforeAll(async () => {
    // Each account brings a Workspace, an OWNER membership and audit rows,
    // a seeded bible (a book, elements, fields, a relation and versions), a
    // vector (2.0) and an interview (2.2): a row in every scoped table, for
    // both workspaces.
    a = await createAccount({ workspaceName: 'RLS A' });
    b = await createAccount({ workspaceName: 'RLS B' });
    const aBook = await seedBible(workspaceCtx(a), 'rls-a');
    const bBook = await seedBible(workspaceCtx(b), 'rls-b');
    await seedVectors(workspaceCtx(a), aBook.bookId, 'rls-a');
    await seedVectors(workspaceCtx(b), bBook.bookId, 'rls-b');
    // An interview with a round, its questions and an answer (Phase 2.2).
    await seedInterview(workspaceCtx(a), aBook.bookId, aBook.characterId, 'rls-a');
    await seedInterview(workspaceCtx(b), bBook.bookId, bBook.characterId, 'rls-b');
    // A round reconciled into proposals (Phase 2.5): a run, proposals and their citations.
    for (const [acct, book] of [[a, aBook], [b, bBook]] as const) {
        const seeded = await seedReconciledRound(workspaceCtx(acct), book.bookId, book.characterId);
        if (!seeded.closed.reconcile?.proposed.ADD) throw new Error('the RLS fixture proposed nothing');
    }
    // A research run (Phase 2.6): a brief and its file, a run, findings with citations, proposals and their findings.
    for (const [acct, book] of [[a, aBook], [b, bBook]] as const) {
        const seeded = await seedResearchRun(workspaceCtx(acct), book.bookId, book.characterId);
        if (seeded.result.outcome !== 'OK') throw new Error(`the RLS research fixture ended ${String(seeded.result.outcome)}`);
    }
    // A story map (Phase 3.1): the map, its nodes and edge, and the save's snapshot.
    await seedStoryMap(workspaceCtx(a), aBook, 'rls-a');
    await seedStoryMap(workspaceCtx(b), bBook, 'rls-b');
    // The source library (Phase 4.0): a book source and a series source, chunks, facts, an opt-in and an override.
    await seedSourceLibrary(workspaceCtx(a), aBook.bookId, 'rls-a');
    await seedSourceLibrary(workspaceCtx(b), bBook.bookId, 'rls-b');
    // The fact layer (4.1): bible facts, a provenance row and a proposal (the outbox and embedding tasks come with the versions).
    await seedFactLayer(workspaceCtx(a), aBook.bookId, 'rls-a');
    await seedFactLayer(workspaceCtx(b), bBook.bookId, 'rls-b');
    // Continuity (4.2): a thread by hand and one proposed, a stale flag, a nightly run and its state.
    await seedContinuity(workspaceCtx(a), aBook.bookId, 'rls-a');
    await seedContinuity(workspaceCtx(b), bBook.bookId, 'rls-b');
    // The model layer's ledger (2.1): a settled call and a live reservation.
    await seedAiCall(workspaceCtx(a), aBook.bookId, 'rls-a');
    await seedAiCall(workspaceCtx(b), bBook.bookId, 'rls-b');
    await seedReservation(workspaceCtx(a), `rls-a-${randomBytes(4).toString('hex')}`);
    await seedReservation(workspaceCtx(b), `rls-b-${randomBytes(4).toString('hex')}`);
    // The interview defaults (2.3): a workspace layer and a book layer each.
    for (const [acct, book] of [[a, aBook], [b, bBook]] as const) {
        await setWorkspaceInterviewDefaults(workspaceCtx(acct), { depth: 2 });
        await setBookInterviewDefaults(workspaceCtx(acct), book.bookId, { detail: 4 });
    }
}, 60_000);

it('there is something to cover: zero tables is never complete coverage', () => {
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped).toEqual(
        expect.arrayContaining([
            'Workspace',
            'WorkspaceMembership',
            'AuditLog',
            'Book',
            'BibleElement',
            'BibleField',
            'BibleRelation',
            'BibleEntryVersion',
            'VectorEmbedding',
            'InterviewSession',
            'InterviewRound',
            'Question',
            'Answer',
            'WorkspaceInterviewDefaults',
            'BookInterviewDefaults',
            'ReconcileRun',
            'EnrichmentProposal',
            'EnrichmentCitation',
            'ResearchBrief',
            'ResearchSource',
            'ResearchRun',
            'ResearchFinding',
            'ResearchCitation',
            'ResearchProposal',
            'ResearchProposalFinding',
            'ResearchEgress',
            'AiCallLog',
            'AiSpendMonth',
            'AiSpendReservation',
            'StoryMap',
            'MapNode',
            'MapEdge',
            'MapSnapshot',
            'SourceLibrary',
            'Source',
            'SourceChunk',
            'StoryFact',
            'BookSeriesSource',
            'StoryFactOverride',
            'StoryFactProvenance',
            'StoryFactProposal',
            'BibleFactExtraction',
            'EmbeddingTask',
            'ContinuityCheck',
            'ContinuityRun',
            'StoryThread',
            'StoryThreadProposal',
            'StaleFlag',
        ]),
    );
});

it.each(scoped)('%s has FORCE RLS and exactly the expected workspace_isolation and superuser_bypass policies', async (table) => {
    expect(rlsProblems(await factsFor(table))).toEqual([]);
});

it.each(scoped)("%s: app_user in workspace A sees its own rows, none of B's, and cannot insert one of B's", async (table) => {
    expect(await isolationLeaks(table, a.workspaceId, b.workspaceId)).toEqual([]);
    expect(await isolationLeaks(table, b.workspaceId, a.workspaceId)).toEqual([]);
});

it('every other table in the schema is a declared global model', async () => {
    const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    const unclassified = tables.map((t) => t.tablename).filter((t) => !scoped.includes(t) && !(t in GLOBAL_MODELS));
    expect(unclassified).toEqual([]);
});

describe('the checkers (negative controls on scratch tables)', () => {
    async function withProbe(fn: (probe: string) => Promise<void>): Promise<void> {
        const probe = `RlsProbe_${randomBytes(4).toString('hex')}`;
        await prisma.$executeRawUnsafe(`CREATE TABLE "${probe}" ("id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL)`);
        try {
            await fn(probe);
        } finally {
            await prisma.$executeRawUnsafe(`DROP TABLE "${probe}"`);
        }
    }

    async function secure(probe: string, isolationPredicate: string): Promise<void> {
        await prisma.$executeRawUnsafe(`ALTER TABLE "${probe}" ENABLE ROW LEVEL SECURITY`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "${probe}" FORCE ROW LEVEL SECURITY`);
        await prisma.$executeRawUnsafe(`CREATE POLICY workspace_isolation ON "${probe}" USING (${isolationPredicate}) WITH CHECK (${isolationPredicate})`);
        await prisma.$executeRawUnsafe(`CREATE POLICY superuser_bypass ON "${probe}" USING (current_setting('role') != 'app_user')`);
        await prisma.$executeRawUnsafe(`INSERT INTO "${probe}" VALUES ('pa', $1), ('pb', $2)`, a.workspaceId, b.workspaceId);
    }

    it('catches a table with no policies', () =>
        withProbe(async (probe) => {
            expect(rlsProblems(await factsFor(probe))).toEqual(
                expect.arrayContaining([
                    `${probe}: row level security is not enabled`,
                    `${probe}: row level security is not FORCED`,
                    `${probe}: no workspace_isolation policy`,
                    `${probe}: no superuser_bypass policy`,
                ]),
            );
        }));

    it('catches a read-only isolation policy and a table that is not forced', () =>
        withProbe(async (probe) => {
            await prisma.$executeRawUnsafe(`ALTER TABLE "${probe}" ENABLE ROW LEVEL SECURITY`);
            await prisma.$executeRawUnsafe(
                `CREATE POLICY workspace_isolation ON "${probe}" FOR SELECT USING ("workspaceId" = current_setting('app.workspace_id', true))`,
            );
            const problems = rlsProblems(await factsFor(probe));
            expect(problems).toContain(`${probe}: row level security is not FORCED`);
            expect(problems).toContain(`${probe}: workspace_isolation is limited to SELECT, expected ALL`);
        }));

    it('a correct scratch policy passes both checkers (the controls below fail for their predicate, not the setup)', () =>
        withProbe(async (probe) => {
            await secure(probe, `"workspaceId" = current_setting('app.workspace_id', true)::text`);
            expect(rlsProblems(await factsFor(probe))).toEqual([]);
            expect(await isolationLeaks(probe, a.workspaceId, b.workspaceId)).toEqual([]);
        }));

    it('catches an INVERTED isolation policy (= written as !=)', () =>
        withProbe(async (probe) => {
            await secure(probe, `"workspaceId" != current_setting('app.workspace_id', true)::text`);
            expect(rlsProblems(await factsFor(probe))).toEqual(
                expect.arrayContaining([expect.stringMatching(/workspace_isolation USING is .*<>/), expect.stringMatching(/workspace_isolation WITH CHECK is .*<>/)]),
            );
            const leaks = await isolationLeaks(probe, a.workspaceId, b.workspaceId);
            expect(leaks).toEqual(
                expect.arrayContaining([
                    `${probe}: app_user cannot see its own workspace's rows (a vacuous control proves nothing)`,
                    `${probe}: app_user bound to one workspace sees 1 row(s) of another`,
                    `${probe}: inserting a row of another workspace was not refused by RLS (inserted)`,
                ]),
            );
        }));

    it("catches a VACUOUS isolation policy (current_setting('app.workspace_id', true) IS NOT NULL)", () =>
        withProbe(async (probe) => {
            await secure(probe, `current_setting('app.workspace_id', true) IS NOT NULL`);
            expect(rlsProblems(await factsFor(probe))).toEqual(
                expect.arrayContaining([expect.stringMatching(/workspace_isolation USING is .*IS NOT NULL/)]),
            );
            const leaks = await isolationLeaks(probe, a.workspaceId, b.workspaceId);
            expect(leaks).toEqual(
                expect.arrayContaining([
                    `${probe}: app_user bound to one workspace sees 1 row(s) of another`,
                    `${probe}: inserting a row of another workspace was not refused by RLS (inserted)`,
                ]),
            );
        }));

    it('catches a widened bypass and an extra permissive policy', () =>
        withProbe(async (probe) => {
            await secure(probe, `"workspaceId" = current_setting('app.workspace_id', true)::text`);
            await prisma.$executeRawUnsafe(`DROP POLICY superuser_bypass ON "${probe}"`);
            await prisma.$executeRawUnsafe(`CREATE POLICY superuser_bypass ON "${probe}" USING (true)`);
            await prisma.$executeRawUnsafe(`CREATE POLICY open_reads ON "${probe}" FOR SELECT USING (true)`);
            const problems = rlsProblems(await factsFor(probe));
            expect(problems).toContain(`${probe}: superuser_bypass USING is true, expected (current_setting('role'::text) <> 'app_user'::text)`);
            expect(problems).toContain(`${probe}: unexpected policy open_reads`);
        }));
});
