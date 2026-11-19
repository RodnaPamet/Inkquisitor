/**
 * A workspace-scoped model cannot ship without its row-level security.
 *
 * No database: this reads the Prisma schema files and the migration SQL from
 * git. Every model with a `workspaceId` field (and `Workspace` itself, scoped
 * on its own id) must have, somewhere in the migrations:
 *
 *   ALTER TABLE "<T>" ENABLE ROW LEVEL SECURITY
 *   ALTER TABLE "<T>" FORCE ROW LEVEL SECURITY
 *   CREATE POLICY workspace_isolation ON "<T>" … USING (…app.workspace_id…) WITH CHECK (…app.workspace_id…)
 *   CREATE POLICY superuser_bypass ON "<T>" …
 *
 * and every other model must be a declared global model (`GLOBAL_MODELS`).
 * The live-database twin is tests/integration/rls-coverage.test.ts; this one
 * fails before a migration is ever applied. The checker is proved against a
 * synthetic schema at the bottom.
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRelativeFiles } from '../helpers/repo-files';
import { GLOBAL_MODELS, workspaceScopedModelNames } from '@/lib/db/rls-tripwire';

const ROOT = path.resolve(__dirname, '../..');

interface ModelInfo {
    name: string;
    table: string;
    hasWorkspaceId: boolean;
}

/** Models from schema text: name, mapped table name, and whether a `workspaceId` field exists. */
export function parseModels(schema: string): ModelInfo[] {
    const models: ModelInfo[] = [];
    const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(schema))) {
        const body = m[2];
        const map = /@@map\(\s*"([^"]+)"\s*\)/.exec(body);
        models.push({ name: m[1], table: map ? map[1] : m[1], hasWorkspaceId: /^\s*workspaceId\s+\S/m.test(body) });
    }
    return models;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The column a table is scoped on: `Workspace` on its own id, everything else on `workspaceId`. */
export function isolationColumn(table: string): string {
    return table === 'Workspace' ? 'id' : 'workspaceId';
}

/** Whitespace collapsed, so a reflowed statement compares equal. */
function normaliseSql(stmt: string): string {
    return stmt.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

/** The one isolation statement a scoped table's migration may carry, exactly. */
export function expectedIsolationStatement(table: string): string {
    const pred = `"${isolationColumn(table)}" = current_setting('app.workspace_id', true)::text`;
    return `CREATE POLICY workspace_isolation ON "${table}" USING (${pred}) WITH CHECK (${pred})`;
}

/** The one bypass statement a scoped table's migration may carry, exactly. */
export function expectedBypassStatement(table: string): string {
    return `CREATE POLICY superuser_bypass ON "${table}" USING (current_setting('role') != 'app_user')`;
}

/** The LAST statement of the given policy on the table, normalised (a later CREATE replaces an earlier one). */
function lastPolicyStatement(policy: string, t: string, sql: string): { stmt: string; index: number } | null {
    const re = new RegExp(`CREATE POLICY ${policy} ON "${t}"[^;]*;`, 'g');
    let last: { stmt: string; index: number } | null = null;
    for (const m of sql.matchAll(re)) last = { stmt: normaliseSql(m[0].slice(0, -1)), index: m.index ?? 0 };
    return last;
}

/**
 * What the migrations lack for one scoped table. The policies are compared
 * as whole statements (whitespace aside), never searched for a substring:
 * "mentions app.workspace_id" is true of an inverted (`!=`) or vacuous
 * (`IS NOT NULL`) predicate too. The live-database twin compares what
 * PostgreSQL stored and proves the policies isolate.
 */
export function migrationProblems(table: string, sql: string): string[] {
    const t = escapeRe(table);
    const problems: string[] = [];
    if (!new RegExp(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`).test(sql)) problems.push(`${table}: RLS never enabled`);
    if (!new RegExp(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`).test(sql)) problems.push(`${table}: RLS never forced`);
    if (new RegExp(`ALTER TABLE "${t}" (NO FORCE|DISABLE) ROW LEVEL SECURITY`).test(sql)) {
        problems.push(`${table}: RLS is disabled or un-forced by a later statement`);
    }
    for (const [policy, expected] of [
        ['workspace_isolation', expectedIsolationStatement(table)],
        ['superuser_bypass', expectedBypassStatement(table)],
    ] as const) {
        const last = lastPolicyStatement(policy, t, sql);
        if (!last) {
            problems.push(`${table}: no ${policy} policy`);
            continue;
        }
        if (last.stmt !== expected) problems.push(`${table}: ${policy} is \`${last.stmt}\`, expected \`${expected}\``);
        const droppedAfter = new RegExp(`DROP POLICY (IF EXISTS )?${policy} ON "${t}"`, 'g');
        for (const m of sql.matchAll(droppedAfter)) {
            if ((m.index ?? 0) > last.index) problems.push(`${table}: ${policy} is dropped after it is created`);
        }
        if (new RegExp(`ALTER POLICY ${policy} ON "${t}"`).test(sql)) problems.push(`${table}: ${policy} is altered after it is created`);
    }
    const other = new RegExp(`CREATE POLICY (\\w+) ON "${t}"`, 'g');
    for (const m of sql.matchAll(other)) {
        if (m[1] !== 'workspace_isolation' && m[1] !== 'superuser_bypass') problems.push(`${table}: unexpected policy ${m[1]}`);
    }
    return problems;
}

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const files = repoRelativeFiles();
const schema = files.filter((f) => /^prisma\/schema\/.*\.prisma$/.test(f)).map(read).join('\n');
const migrations = files.filter((f) => /^prisma\/migrations\/.*\.sql$/.test(f)).sort().map(read).join('\n');
const models = parseModels(schema);
const scoped = models.filter((m) => m.hasWorkspaceId || m.name === 'Workspace');

it('reads a schema with models in it (zero models is never full coverage)', () => {
    expect(models.length).toBeGreaterThan(0);
    expect(scoped.map((m) => m.name)).toEqual(
        expect.arrayContaining(['Workspace', 'WorkspaceMembership', 'AuditLog', 'Book', 'BibleElement', 'BibleField', 'BibleRelation', 'BibleEntryVersion']),
    );
});

it('agrees with the runtime list the tripwire uses', () => {
    expect(scoped.map((m) => m.name).sort()).toEqual([...workspaceScopedModelNames()].sort());
});

it.each(scoped.map((m) => [m.name, m.table]))('%s has its row-level security in the migrations', (_name, table) => {
    expect(migrationProblems(table, migrations)).toEqual([]);
});

it('every model without a workspaceId is a declared global model', () => {
    const unclassified = models.filter((m) => !m.hasWorkspaceId && m.name !== 'Workspace' && !(m.name in GLOBAL_MODELS)).map((m) => m.name);
    expect(unclassified).toEqual([]);
});

it('no declared global model carries a workspaceId (it would be scoped and global at once)', () => {
    expect(models.filter((m) => m.name in GLOBAL_MODELS && m.hasWorkspaceId).map((m) => m.name)).toEqual([]);
});

describe('the checker (negative controls)', () => {
    const synthetic = `model Chapter {\n  id String @id\n  workspaceId String\n  title String\n}\n`;

    it('finds the workspaceId of a new model', () => {
        expect(parseModels(synthetic)).toEqual([{ name: 'Chapter', table: 'Chapter', hasWorkspaceId: true }]);
    });

    it('flags a scoped model whose migration has no policy', () => {
        expect(migrationProblems('Chapter', 'CREATE TABLE "Chapter" ("id" TEXT);')).toEqual([
            'Chapter: RLS never enabled',
            'Chapter: RLS never forced',
            'Chapter: no workspace_isolation policy',
            'Chapter: no superuser_bypass policy',
        ]);
    });

    const complete = (isolation: string, bypass = `CREATE POLICY superuser_bypass ON "Chapter" USING (current_setting('role') != 'app_user');`) =>
        ['ALTER TABLE "Chapter" ENABLE ROW LEVEL SECURITY;', 'ALTER TABLE "Chapter" FORCE ROW LEVEL SECURITY;', isolation, bypass].join('\n');
    const isolationProblem = (problems: string[]) => problems.filter((p) => p.startsWith('Chapter: workspace_isolation is `'));

    it('flags an isolation policy without WITH CHECK, or limited to one command', () => {
        expect(
            isolationProblem(
                migrationProblems(
                    'Chapter',
                    complete(`CREATE POLICY workspace_isolation ON "Chapter" FOR SELECT USING ("workspaceId" = current_setting('app.workspace_id', true)::text);`),
                ),
            ),
        ).toHaveLength(1);
    });

    it('flags an INVERTED isolation predicate (= written as !=)', () => {
        const inverted = `"workspaceId" != current_setting('app.workspace_id', true)::text`;
        const problems = migrationProblems('Chapter', complete(`CREATE POLICY workspace_isolation ON "Chapter" USING (${inverted}) WITH CHECK (${inverted});`));
        expect(isolationProblem(problems)).toHaveLength(1);
    });

    it('flags a VACUOUS isolation predicate (IS NOT NULL), though it reads app.workspace_id', () => {
        const vacuous = `current_setting('app.workspace_id', true) IS NOT NULL`;
        const problems = migrationProblems('Chapter', complete(`CREATE POLICY workspace_isolation ON "Chapter" USING (${vacuous}) WITH CHECK (${vacuous});`));
        expect(isolationProblem(problems)).toHaveLength(1);
    });

    it('flags a widened bypass, a later drop and a third policy', () => {
        const ok = `"workspaceId" = current_setting('app.workspace_id', true)::text`;
        const sql = [
            complete(`CREATE POLICY workspace_isolation ON "Chapter" USING (${ok}) WITH CHECK (${ok});`, `CREATE POLICY superuser_bypass ON "Chapter" USING (true);`),
            'DROP POLICY workspace_isolation ON "Chapter";',
            'CREATE POLICY open_reads ON "Chapter" FOR SELECT USING (true);',
        ].join('\n');
        const problems = migrationProblems('Chapter', sql);
        expect(problems).toContain(
            `Chapter: superuser_bypass is \`CREATE POLICY superuser_bypass ON "Chapter" USING (true)\`, expected \`CREATE POLICY superuser_bypass ON "Chapter" USING (current_setting('role') != 'app_user')\``,
        );
        expect(problems).toContain('Chapter: workspace_isolation is dropped after it is created');
        expect(problems).toContain('Chapter: unexpected policy open_reads');
    });

    it('a complete set passes', () => {
        const sql = [
            'ALTER TABLE "Chapter" ENABLE ROW LEVEL SECURITY;',
            'ALTER TABLE "Chapter" FORCE ROW LEVEL SECURITY;',
            `CREATE POLICY workspace_isolation ON "Chapter" USING ("workspaceId" = current_setting('app.workspace_id', true)::text) WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);`,
            `CREATE POLICY superuser_bypass ON "Chapter" USING (current_setting('role') != 'app_user');`,
        ].join('\n');
        expect(migrationProblems('Chapter', sql)).toEqual([]);
    });
});
