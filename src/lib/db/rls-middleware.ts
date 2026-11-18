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
import { runWithDbContext } from './db-context';
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
    return runWithDbContext(
        { workspaceId: ctx.workspaceId, actorUserId: ctx.userId, requestId: ctx.requestId, source: 'workspace' },
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
    /** Tests exercising the bypass path or seeding rows. */
    | 'test';

const KNOWN_REASONS: ReadonlySet<RlsBypassReason> = new Set<RlsBypassReason>([
    'auth-identity',
    'workspace-discovery',
    'workspace-creation',
    'audit-verification',
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

export { WORKSPACE_SCOPED_MODELS, workspaceScopedModelNames, withRlsTripwire } from './rls-tripwire';
