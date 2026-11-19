/**
 * Every workspace-scoped table in the live database carries the full RLS
 * set (tests/helpers/rls-coverage.ts), read from `pg_class` and
 * `pg_policies` after the migrations ran. The denominator is the schema, not
 * a list in this file: every model with a `workspaceId` (plus `Workspace`)
 * must be covered, and every other table must be a declared global model —
 * so a new table fails here until it has its policies or a reviewed reason
 * not to.
 *
 * The checker is proved against a scratch table that has a `workspaceId` and
 * no policy: if the rules ever stopped detecting that, this suite fails.
 */
import { prisma } from '@/lib/db';
import { GLOBAL_MODELS, workspaceScopedModelNames } from '@/lib/db/rls-tripwire';
import { rlsProblems, type TableRlsFacts } from '../helpers/rls-coverage';

afterAll(() => prisma.$disconnect());

async function factsFor(table: string): Promise<TableRlsFacts> {
    const cls = await prisma.$queryRaw<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
        SELECT c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ${table}`;
    if (cls.length === 0) throw new Error(`table ${table} does not exist`);
    const policies = await prisma.$queryRaw<Array<{ policyname: string; qual: string | null; with_check: string | null }>>`
        SELECT policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = ${table}`;
    return {
        table,
        rlsEnabled: cls[0].relrowsecurity,
        rlsForced: cls[0].relforcerowsecurity,
        policies: policies.map((p) => ({ name: p.policyname, qual: p.qual, withCheck: p.with_check })),
    };
}

const scoped = workspaceScopedModelNames();

it('there is something to cover: zero tables is never complete coverage', () => {
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped).toEqual(expect.arrayContaining(['Workspace', 'WorkspaceMembership', 'AuditLog']));
});

it.each(scoped)('%s has FORCE RLS, workspace_isolation (USING + WITH CHECK) and superuser_bypass', async (table) => {
    expect(rlsProblems(await factsFor(table))).toEqual([]);
});

it('every other table in the schema is a declared global model', async () => {
    const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    const unclassified = tables.map((t) => t.tablename).filter((t) => !scoped.includes(t) && !(t in GLOBAL_MODELS));
    expect(unclassified).toEqual([]);
});

it('the checker catches a workspace table with no policies (negative control)', async () => {
    const probe = `RlsProbe_${Date.now()}`;
    await prisma.$executeRawUnsafe(`CREATE TABLE "${probe}" ("id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL)`);
    try {
        const bare = rlsProblems(await factsFor(probe));
        expect(bare).toEqual(
            expect.arrayContaining([
                `${probe}: row level security is not enabled`,
                `${probe}: row level security is not FORCED`,
                `${probe}: no workspace_isolation policy`,
                `${probe}: no superuser_bypass policy`,
            ]),
        );
        // Enabled but not forced, with a read-only policy: still caught.
        await prisma.$executeRawUnsafe(`ALTER TABLE "${probe}" ENABLE ROW LEVEL SECURITY`);
        await prisma.$executeRawUnsafe(
            `CREATE POLICY workspace_isolation ON "${probe}" FOR SELECT USING ("workspaceId" = current_setting('app.workspace_id', true))`,
        );
        const partial = rlsProblems(await factsFor(probe));
        expect(partial).toContain(`${probe}: row level security is not FORCED`);
        expect(partial).toContain(`${probe}: workspace_isolation WITH CHECK does not read app.workspace_id`);
    } finally {
        await prisma.$executeRawUnsafe(`DROP TABLE "${probe}"`);
    }
});
