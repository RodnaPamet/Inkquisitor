/**
 * The RLS coverage rules, as pure checks over what the database says about a
 * table, so the coverage test can prove its checker catches a gap.
 *
 * A workspace-scoped table must have, all of:
 *   - ROW LEVEL SECURITY enabled and FORCED (the owner is bound too);
 *   - a `workspace_isolation` policy that is EXACTLY
 *       PERMISSIVE, TO public, FOR ALL,
 *       USING      (<col> = current_setting('app.workspace_id', true))
 *       WITH CHECK (<col> = current_setting('app.workspace_id', true))
 *     where <col> is `id` for `Workspace` and `workspaceId` everywhere else;
 *   - a `superuser_bypass` policy that is EXACTLY
 *       PERMISSIVE, TO public, FOR ALL,
 *       USING (current_setting('role') <> 'app_user'), no separate WITH CHECK;
 *   - and no other policy (a permissive sibling is OR'd in and could open it).
 *
 * The expressions are compared as PostgreSQL normalises them in
 * `pg_policies` (PostgreSQL 16, the version CI and the compose stack run), not
 * searched for a substring: "reads app.workspace_id" is true of an inverted
 * policy (`!=`) and of a vacuous one (`… IS NOT NULL`) alike.
 */
export interface PolicyFacts {
    name: string;
    permissive: string;
    roles: string[];
    cmd: string;
    qual: string | null;
    withCheck: string | null;
}

export interface TableRlsFacts {
    table: string;
    rlsEnabled: boolean;
    rlsForced: boolean;
    policies: PolicyFacts[];
}

/** The column a table is scoped on. */
export function isolationColumn(table: string): string {
    return table === 'Workspace' ? 'id' : 'workspaceId';
}

/** An identifier as `pg_get_expr` prints it: bare when it needs no quotes. */
function printedIdentifier(name: string): string {
    return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name}"`;
}

export function expectedPolicies(table: string): Record<'workspace_isolation' | 'superuser_bypass', Omit<PolicyFacts, 'name'>> {
    const predicate = `(${printedIdentifier(isolationColumn(table))} = current_setting('app.workspace_id'::text, true))`;
    return {
        workspace_isolation: { permissive: 'PERMISSIVE', roles: ['public'], cmd: 'ALL', qual: predicate, withCheck: predicate },
        superuser_bypass: {
            permissive: 'PERMISSIVE',
            roles: ['public'],
            cmd: 'ALL',
            qual: "(current_setting('role'::text) <> 'app_user'::text)",
            withCheck: null,
        },
    };
}

export function rlsProblems(facts: TableRlsFacts): string[] {
    const problems: string[] = [];
    if (!facts.rlsEnabled) problems.push(`${facts.table}: row level security is not enabled`);
    if (!facts.rlsForced) problems.push(`${facts.table}: row level security is not FORCED`);
    const expected = expectedPolicies(facts.table);
    for (const [name, want] of Object.entries(expected)) {
        const got = facts.policies.find((p) => p.name === name);
        if (!got) {
            problems.push(`${facts.table}: no ${name} policy`);
            continue;
        }
        if (got.permissive !== want.permissive) problems.push(`${facts.table}: ${name} is ${got.permissive}, expected ${want.permissive}`);
        if (JSON.stringify([...got.roles].sort()) !== JSON.stringify(want.roles)) {
            problems.push(`${facts.table}: ${name} applies to {${got.roles.join(',')}}, expected {${want.roles.join(',')}}`);
        }
        if (got.cmd !== want.cmd) problems.push(`${facts.table}: ${name} is limited to ${got.cmd}, expected ${want.cmd}`);
        if (got.qual !== want.qual) problems.push(`${facts.table}: ${name} USING is ${got.qual ?? 'absent'}, expected ${want.qual}`);
        if (got.withCheck !== want.withCheck) {
            problems.push(`${facts.table}: ${name} WITH CHECK is ${got.withCheck ?? 'absent'}, expected ${want.withCheck ?? 'absent'}`);
        }
    }
    const others = facts.policies.filter((p) => !(p.name in expected));
    for (const p of others) problems.push(`${facts.table}: unexpected policy ${p.name}`);
    return problems;
}
