/**
 * The RLS coverage rules, as pure checks over what the database (or the
 * migrations) say about a table, so both coverage tests apply the SAME rules
 * and each can prove its checker catches a gap.
 *
 * A workspace-scoped table must have, all of:
 *   - ROW LEVEL SECURITY enabled and FORCED (the owner is bound too);
 *   - a `workspace_isolation` policy whose USING and WITH CHECK both read
 *     `app.workspace_id` (reads and writes);
 *   - the `superuser_bypass` policy keyed on the role not being app_user.
 */
export interface TableRlsFacts {
    table: string;
    rlsEnabled: boolean;
    rlsForced: boolean;
    policies: Array<{ name: string; qual: string | null; withCheck: string | null }>;
}

export function rlsProblems(facts: TableRlsFacts): string[] {
    const problems: string[] = [];
    if (!facts.rlsEnabled) problems.push(`${facts.table}: row level security is not enabled`);
    if (!facts.rlsForced) problems.push(`${facts.table}: row level security is not FORCED`);
    const isolation = facts.policies.find((p) => p.name === 'workspace_isolation');
    if (!isolation) {
        problems.push(`${facts.table}: no workspace_isolation policy`);
    } else {
        if (!isolation.qual?.includes('app.workspace_id')) problems.push(`${facts.table}: workspace_isolation USING does not read app.workspace_id`);
        if (!isolation.withCheck?.includes('app.workspace_id')) problems.push(`${facts.table}: workspace_isolation WITH CHECK does not read app.workspace_id`);
    }
    const bypass = facts.policies.find((p) => p.name === 'superuser_bypass');
    if (!bypass) problems.push(`${facts.table}: no superuser_bypass policy`);
    else if (!bypass.qual?.includes('app_user')) problems.push(`${facts.table}: superuser_bypass is not keyed on app_user`);
    const others = facts.policies.filter((p) => p.name !== 'workspace_isolation' && p.name !== 'superuser_bypass');
    // A third permissive policy would be OR'd with the isolation policy and could open it.
    for (const p of others) problems.push(`${facts.table}: unexpected policy ${p.name}`);
    return problems;
}
