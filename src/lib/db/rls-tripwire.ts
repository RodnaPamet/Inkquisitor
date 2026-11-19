/**
 * The RLS tripwire and the list of workspace-scoped models.
 *
 * A leaf module (no import of the client) so `src/lib/db.ts` can compose the
 * tripwire onto the client it builds while `./rls-middleware.ts` imports
 * that client. See `./rls-middleware.ts` for the whole RLS story.
 *
 * Lifted from inflect-compliance's `src/lib/db/rls-middleware.ts` (the
 * tripwire half; see docs/carve-manifest.md).
 */
import { Prisma } from '@prisma/client';
import { logger } from '@/lib/observability/logger';
import { getDbContext } from './db-context';

// ─── Workspace-scoped models ────────────────────────────────────────

/**
 * Every model with a `workspaceId` column, read from Prisma's datamodel so it
 * cannot drift from the schema, plus `Workspace` itself (scoped on its id).
 * This is the denominator of the tripwire and of both RLS coverage tests.
 */
export function workspaceScopedModelNames(): string[] {
    const direct = Prisma.dmmf.datamodel.models
        .filter((m) => m.fields.some((f) => f.name === 'workspaceId'))
        .map((m) => m.name);
    return ['Workspace', ...direct];
}

export const WORKSPACE_SCOPED_MODELS: ReadonlySet<string> = new Set(workspaceScopedModelNames());

/**
 * The models that are deliberately NOT workspace-scoped, each with the reason.
 * Every model is one or the other: the RLS coverage tests
 * (tests/guards/rls-migration-coverage.test.ts,
 * tests/integration/rls-coverage.test.ts) fail for a model that has no
 * `workspaceId` and is not listed here, so a new table cannot dodge row-level
 * security by simply leaving the column out. Adding an entry is a review
 * decision: it says no workspace's data can ever live in that table.
 */
export const GLOBAL_MODELS: Readonly<Record<string, string>> = Object.freeze({
    User: 'A person exists before and across workspaces; a member list reads names through a workspace context.',
    Account: 'An OAuth identity of a person; read on the plain client by sign-in only (app_user holds no grant).',
    VerificationToken: 'An email-verification token keyed by address, before any workspace is known (app_user holds no grant).',
    UserSession: 'A signed-in browser of a person, who may reach several workspaces (app_user holds no grant).',
});

const WRITE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert']);

/** Wire the observation-only tripwire onto a client (outermost extension). */
export function withRlsTripwire<T extends object>(client: T): T {
    return (client as { $extends: (cfg: unknown) => unknown }).$extends({
        name: 'rls-tripwire',
        query: {
            $allModels: {
                async $allOperations({
                    model,
                    operation,
                    args,
                    query,
                }: {
                    model: string;
                    operation: string;
                    args: unknown;
                    query: (a: unknown) => Promise<unknown>;
                }) {
                    if (WORKSPACE_SCOPED_MODELS.has(model)) {
                        const source = getDbContext()?.source;
                        if (!source) {
                            const fields = { component: 'rls-middleware', model, operation };
                            if (WRITE_OPERATIONS.has(operation)) {
                                logger.warn('rls-middleware.missing_workspace_context', fields);
                            } else {
                                logger.debug('rls-middleware.missing_workspace_context', fields);
                            }
                        }
                    }
                    return query(args);
                },
            },
        },
    }) as T;
}
