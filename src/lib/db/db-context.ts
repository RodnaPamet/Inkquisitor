/**
 * The database context — which workspace the current async execution's
 * queries act in, for the Prisma extensions.
 *
 * The encryption extension picks the workspace's data key from it, and the
 * RLS tripwire warns when a workspace-scoped model is queried without it.
 * Bound ONLY by `src/lib/db/rls-middleware.ts` (`runInWorkspaceContext`,
 * `runWithoutRls`); nothing else writes it.
 *
 * AsyncLocalStorage, never a module-level stack: inflect-compliance ran a
 * LIFO stack here until concurrent requests interleaved and one sealed its
 * rows with another tenant's key (inflect's `src/lib/audit-context.ts` tells
 * the story). Each async execution sees only the store it entered.
 *
 * This is NOT the authorization context (`RequestContext`, passed explicitly)
 * and NOT the observability context (`@/lib/observability/context`).
 *
 * Lifted from inflect-compliance's `src/lib/audit-context.ts` (see
 * docs/carve-manifest.md), cut to the fields Inkquisitor's extensions read.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface DbContextData {
    /** The workspace the transaction's `app.workspace_id` names. */
    workspaceId?: string;
    actorUserId?: string;
    requestId?: string;
    /**
     * `workspace` inside `runInWorkspaceContext`; `bypass:<reason>` inside
     * `runWithoutRls`. The tripwire is silent for both.
     */
    source?: string;
}

const store = new AsyncLocalStorage<DbContextData>();

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return value != null && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * Run `fn` with `ctx` bound. A Prisma query is LAZY — building it runs
 * nothing until something awaits it — so a returned thenable is awaited
 * inside the store's scope; otherwise the query would fire after `run`
 * returned, with no context.
 */
export function runWithDbContext<T>(ctx: DbContextData, fn: () => T | Promise<T>): Promise<T> {
    return store.run({ ...ctx }, async () => {
        const result = fn();
        return isThenable(result) ? await result : result;
    });
}

export function getDbContext(): DbContextData | undefined {
    return store.getStore();
}
