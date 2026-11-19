/**
 * Prisma ↔ PostgreSQL row-level security: the ONE way application code
 * reaches a workspace-scoped table.
 *
 *   runInWorkspaceContext(ctx, (db) => …)
 *       Opens a transaction, `SET LOCAL ROLE app_user`, and binds
 *       `app.workspace_id` (and `app.request_id`) with `set_config(…, true)`.
 *       Every policy (`workspace_isolation`) then bites, for every query on
 *       `db`. `SET LOCAL` / `set_config(…, true)` are transaction-scoped, so
 *       they reset at commit or rollback and are safe under PgBouncer's
 *       transaction pooling.
 *
 *   runWithoutRls({ reason }, (db) => …)
 *       The explicit, grep-able bypass, for code that must work before a
 *       workspace is known (sign-in, sign-up, the membership gate). The
 *       `superuser_bypass` policy admits any role but app_user, which is what
 *       the plain client connects as. Every call is logged with its reason;
 *       the reason is a closed union.
 *
 *   withRlsTripwire(client)  (./rls-tripwire.ts, re-exported here)
 *       A Prisma query extension that LOGS (never blocks) a query on a
 *       workspace-scoped model made outside both of the above — warn for a
 *       write, debug for a read. The database is the gate; the tripwire
 *       turns "why is this empty" into a log line naming the model.
 *
 * Lifted from inflect-compliance's `src/lib/db/rls-middleware.ts` and
 * `src/lib/db-context.ts` (see docs/carve-manifest.md): tenant → workspace,
 * `app.tenant_id` → `app.workspace_id`; the read-replica, job and global
 * variants and the audit-extension plumbing are not carried.
 *
 * See docs/rls-workspace-isolation.md.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { RequestContext } from '@/app-layer/types';
import { logger } from '@/lib/observability/logger';
import { runWithDbContext, type DbContextData } from './db-context';
import { workspaceKeysFor } from './key-registry';
import { prisma } from '@/lib/db';

/** The transaction client handed to a context callback. */
export type PrismaTx = Prisma.TransactionClient;

/**
 * Declared, not inherited: Prisma's defaults (2 s to get a connection, 5 s
 * to finish) are whatever the library version says. These are the product's.
 */
export const WORKSPACE_TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

/** What a workspace context needs: an identified workspace (and, for the audit, a request). */
export type WorkspaceScope = Pick<RequestContext, 'requestId' | 'userId'> & { workspaceId: string };

/**
 * Run `callback` in a transaction under the workspace's row-level security.
 * Usecases call this with their `WorkspaceRequestContext`; repositories take
 * the `db` it hands them.
 */
export async function runInWorkspaceContext<T>(
    ctx: WorkspaceScope,
    callback: (db: PrismaTx) => Promise<T>,
    options: { client?: PrismaClient; timeout?: number } = {},
): Promise<T> {
    if (!ctx.workspaceId) {
        throw new Error('runInWorkspaceContext requires a workspaceId');
    }
    const client = options.client ?? prisma;
    // The workspace's data keys, resolved NOW, before the transaction holds a
    // connection: the key manager reads them on a pooled connection of its
    // own, and a lookup made from inside the transaction would wait for a
    // second connection while holding the first (a small pool deadlocks).
    // Only a client that encrypts is registered; a missing key fails here.
    const keys = workspaceKeysFor(client);
    let deks: DbContextData['deks'];
    if (keys) {
        const primary = await keys.getDek(ctx.workspaceId);
        const previous = await keys.getPreviousDek(ctx.workspaceId).catch(() => null);
        deks = { primary, previous };
    }
    return runWithDbContext(
        { workspaceId: ctx.workspaceId, actorUserId: ctx.userId, requestId: ctx.requestId, source: 'workspace', deks },
        () =>
            client.$transaction(
                async (tx) => {
                    await tx.$executeRaw`SET LOCAL ROLE app_user`;
                    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true), set_config('app.request_id', ${ctx.requestId}, true)`;
                    return callback(tx);
                },
                { ...WORKSPACE_TX_OPTIONS, ...(options.timeout ? { timeout: options.timeout } : {}) },
            ),
    );
}

/**
 * Switch a transaction the caller already holds into a workspace's row-level
 * security: `SET LOCAL ROLE app_user` and the transaction-local
 * `app.workspace_id`. For the one flow that must do work as the owning role
 * first and as the workspace after, in ONE transaction: sign-up creates the
 * user and the workspace (no workspace context can exist before the
 * workspace does), then switches here to write the membership and the audit
 * rows under the policies (`src/app-layer/usecases/sign-up.ts`). Everything
 * else uses `runInWorkspaceContext`.
 */
export async function bindWorkspaceInTransaction(tx: PrismaTx, ctx: { workspaceId: string; requestId: string }): Promise<void> {
    if (!ctx.workspaceId) throw new Error('bindWorkspaceInTransaction requires a workspaceId');
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true), set_config('app.request_id', ${ctx.requestId}, true)`;
}

/**
 * Why a caller may skip row-level security. Adding a reason is a review
 * decision, not a routine change; the runtime refuses any other string.
 */
export type RlsBypassReason =
    /** Sign-in and the JWT callback: who is this, and which workspaces are theirs? */
    | 'auth-identity'
    /** The membership gate resolving a workspace slug before a context exists. */
    | 'workspace-discovery'
    /** Sign-up creating a workspace, its key and its OWNER in one transaction. */
    | 'workspace-creation'
    /** Reading a workspace's whole audit chain to verify it. */
    | 'audit-verification'
    /**
     * The daily book purge (Phase 1.H) finding books deleted more than 30 days
     * ago, in every workspace: ids only; each is then purged inside its own
     * workspace's context.
     */
    | 'book-purge-discovery'
    /** Tests exercising the bypass path or seeding rows. */
    | 'test';

const KNOWN_REASONS: ReadonlySet<RlsBypassReason> = new Set<RlsBypassReason>([
    'auth-identity',
    'workspace-discovery',
    'workspace-creation',
    'audit-verification',
    'book-purge-discovery',
    'test',
]);

/** Run `callback` with the plain client, outside row-level security. */
export async function runWithoutRls<T>(
    options: { reason: RlsBypassReason; client?: PrismaClient },
    callback: (db: PrismaClient) => Promise<T>,
): Promise<T> {
    if (!KNOWN_REASONS.has(options.reason)) {
        throw new Error(
            `runWithoutRls called with unknown reason '${String(options.reason)}'. Add it to RlsBypassReason ` +
                'after reviewing whether the bypass is required.',
        );
    }
    logger.debug('rls-middleware.bypass_invoked', { component: 'rls-middleware', reason: options.reason });
    return runWithDbContext({ source: `bypass:${options.reason}` }, () => callback(options.client ?? prisma));
}

export { GLOBAL_MODELS, WORKSPACE_SCOPED_MODELS, workspaceScopedModelNames, withRlsTripwire } from './rls-tripwire';
