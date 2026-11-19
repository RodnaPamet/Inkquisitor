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

/** What the migrations lack for one scoped table. */
export function migrationProblems(table: string, sql: string): string[] {
    const t = escapeRe(table);
    const problems: string[] = [];
    if (!new RegExp(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`).test(sql)) problems.push(`${table}: RLS never enabled`);
    if (!new RegExp(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`).test(sql)) problems.push(`${table}: RLS never forced`);
    // Bounded to the one statement: up to the terminating semicolon.
    const isolation = new RegExp(`CREATE POLICY workspace_isolation ON "${t}"([^;]*);`).exec(sql);
    if (!isolation) {
        problems.push(`${table}: no workspace_isolation policy`);
    } else {
        const stmt = isolation[1];
        const using = /USING\s*\(([^;]*?)\)\s*(WITH CHECK|$)/.exec(stmt);
        const check = /WITH CHECK\s*\(([^;]*)\)/.exec(stmt);
        if (!using || !using[1].includes('app.workspace_id')) problems.push(`${table}: workspace_isolation USING does not read app.workspace_id`);
        if (!check || !check[1].includes('app.workspace_id')) problems.push(`${table}: workspace_isolation has no WITH CHECK on app.workspace_id`);
        if (/\bFOR\s+(SELECT|INSERT|UPDATE|DELETE)\b/i.test(stmt)) problems.push(`${table}: workspace_isolation is limited to one command`);
    }
    if (!new RegExp(`CREATE POLICY superuser_bypass ON "${t}"`).test(sql)) problems.push(`${table}: no superuser_bypass policy`);
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
    expect(scoped.map((m) => m.name)).toEqual(expect.arrayContaining(['Workspace', 'WorkspaceMembership', 'AuditLog']));
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

    it('flags an isolation policy without WITH CHECK, or limited to one command', () => {
        const sql = [
            'ALTER TABLE "Chapter" ENABLE ROW LEVEL SECURITY;',
            'ALTER TABLE "Chapter" FORCE ROW LEVEL SECURITY;',
            `CREATE POLICY workspace_isolation ON "Chapter" FOR SELECT USING ("workspaceId" = current_setting('app.workspace_id', true));`,
            `CREATE POLICY superuser_bypass ON "Chapter" USING (current_setting('role') != 'app_user');`,
        ].join('\n');
        expect(migrationProblems('Chapter', sql)).toEqual([
            'Chapter: workspace_isolation has no WITH CHECK on app.workspace_id',
            'Chapter: workspace_isolation is limited to one command',
        ]);
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
