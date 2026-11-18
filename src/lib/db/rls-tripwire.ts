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
