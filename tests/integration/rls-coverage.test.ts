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
import { createAccount, workspaceCtx } from '../helpers/workspaces';

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
    const [source] = await prisma.$queryRawUnsafe<Array<{ row: Record<string, unknown> }>>(
        `SELECT row_to_json(t) AS row FROM "${table}" t WHERE "${col}" = $1 LIMIT 1`,
        other,
    );
    if (!source) {
        problems.push(`${table}: no row of the other workspace to copy (seed one)`);
        return problems;
    }
    const row = { ...source.row };
    if (col !== 'id' && 'id' in row) row.id = `rls-probe-${randomBytes(6).toString('hex')}`;
    if ('slug' in row) row.slug = `rls-probe-${randomBytes(6).toString('hex')}`;
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
    // a seeded bible (a book, elements, fields, a relation and versions) and
    // a vector (2.0): a row in every scoped table, for both workspaces.
    a = await createAccount({ workspaceName: 'RLS A' });
    b = await createAccount({ workspaceName: 'RLS B' });
    const aBook = await seedBible(workspaceCtx(a), 'rls-a');
    const bBook = await seedBible(workspaceCtx(b), 'rls-b');
    await seedVectors(workspaceCtx(a), aBook.bookId, 'rls-a');
    await seedVectors(workspaceCtx(b), bBook.bookId, 'rls-b');
});

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
