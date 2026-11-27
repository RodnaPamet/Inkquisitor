/**
 * Deleting a whole workspace (Phase 5.H-a, decision D36; roadmap 5.H item 4: "full deletion within 30 days").
 *
 *   requestWorkspaceDeletion   an OWNER (`workspace.delete`), naming the workspace by its exact name, asks for the
 *                              workspace — and, when it is their only one, their account — to be deleted. SOFT:
 *                              `Workspace.deletedAt` (the database's clock) closes it AT ONCE to every member (the
 *                              gate, the claims and every workspace route treat it as missing) and to every background
 *                              job (their discovery leaves it out); its queued jobs are removed. Nothing is deleted yet.
 *   listRestorableWorkspaces   the signed-in person's deleted workspaces they are an OWNER of and may still restore.
 *   restoreWorkspace           one of its OWNERs brings it back, whole, within `WORKSPACE_RESTORE_DAYS` (30), by the
 *                              database's clock; the account deletion asked with it is cancelled too.
 *   purgeDeletedWorkspaces     the daily `workspace-purge` job: every workspace deleted 30 or more days ago is deleted
 *                              for good — its stored objects (`workspaces/<id>/`), every job that names it, and then
 *                              its row, whose cascade takes EVERY workspace-scoped row (books, bibles and their
 *                              history, interviews, sources, facts, vectors, the manuscript and its versions, model
 *                              call records, memberships, settings) — and, when its requester asked and belongs to no
 *                              other workspace by then, their account. Within a day of the deadline: 31 days at most.
 *
 * WHAT IS KEPT, the one honest exception (docs/your-data.md): the workspace's AUDIT TRAIL. It is hash-chained,
 * append-only for every role, and has no foreign key on purpose — it outlives the workspace so the deletion itself is
 * on record — and it holds ids, counts and codes, never author text or an email (CLAUDE.md, "Audit trail"). The purge
 * appends its last row, `WORKSPACE_PURGED`, to that chain, in the same transaction as the delete.
 *
 * Every write is audited (ids and counts); audit last.
 */
import { randomUUID } from 'node:crypto';
import type { UserRequestContext } from '@/app-layer/context';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission, denyPermission } from '@/app-layer/policies/permission.policy';
import { MembershipRepository } from '@/app-layer/repositories/membership.repository';
import { WorkspaceDeletionRepository } from '@/app-layer/repositories/workspace-deletion.repository';
import { appendAuditEntryWithin } from '@/lib/audit/audit-writer';
import { workspaceKeys } from '@/lib/db';
import { bindWorkspaceInTransaction, runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { safeErrorMessage } from '@/lib/observability/safe-error';
import { getPermissionsForRole, hasPermission } from '@/lib/permissions';
import { deleteWorkspaceObjects } from '@/lib/storage';
import { workspaceRestorableUntil, workspaceRestoreCutoff } from '@/lib/workspace/workspace-retention';
import { WorkspaceDeletionRequest } from '@/app-layer/schemas/your-data';

/** How a deletion request, a restore and the purge reach the queue (tests pass their own). */
export interface WorkspaceJobRemover {
    (workspaceId: string): Promise<{ removed: number; active: number; cut: boolean }>;
}

const defaultJobRemover: WorkspaceJobRemover = async (workspaceId) => (await import('@/app-layer/jobs/queue')).removeWorkspaceJobs(workspaceId);

export interface WorkspaceDeletionView {
    workspaceId: string;
    deletedAt: string;
    restorableUntil: string;
    accountDeletionRequested: boolean;
}

/**
 * An OWNER asks for the whole workspace to be deleted (`workspace.delete`). `confirmName` must be the workspace's
 * name exactly (409 NAME_MISMATCH otherwise: a deletion is never one click). `deleteAccount` asks for the caller's
 * account to go with it, and is refused 409 ACCOUNT_HAS_OTHER_WORKSPACES when they belong to another workspace (their
 * account is still in use there). The OWNER's authority is read again under the workspace's owner lock (a demotion
 * that committed first refuses it, audited). Queued jobs of the workspace are removed after the commit; a queue that
 * cannot be reached does not undo the deletion (the purge removes them again).
 */
export async function requestWorkspaceDeletion(
    ctx: WorkspaceRequestContext,
    input: unknown,
    deps: { removeJobs?: WorkspaceJobRemover } = {},
): Promise<WorkspaceDeletionView> {
    await assertPermission(ctx, 'workspace.delete');
    const parsed = WorkspaceDeletionRequest.parse(input);
    if (parsed.deleteAccount) {
        const others = await runWithoutRls({ reason: 'workspace-deletion-discovery' }, (db) => WorkspaceDeletionRepository.countOtherMemberships(db, ctx.userId, ctx.workspaceId));
        if (others > 0) throw new ConflictError('Your account belongs to another workspace too.', { reason: 'ACCOUNT_HAS_OTHER_WORKSPACES', workspaces: others });
    }
    const outcome = await runInWorkspaceContext(ctx, async (db) => {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'workspace-owner:' + ctx.workspaceId}))`;
        const me = await MembershipRepository.findForUser(db, ctx.workspaceId, ctx.userId);
        if (!me || !hasPermission(getPermissionsForRole(me.role), 'workspace.delete')) return { denied: me?.role ?? null } as const;
        const ws = await WorkspaceDeletionRepository.findLive(db, ctx.workspaceId);
        if (!ws) throw new NotFoundError('Workspace not found or access not permitted.');
        if (ws.name.trim() !== parsed.confirmName.trim()) throw new ConflictError('That is not the workspace’s name.', { reason: 'NAME_MISMATCH' });
        const deleted = await WorkspaceDeletionRepository.markDeleted(db, ctx.workspaceId, { deletedById: ctx.userId, purgeAccountOfId: parsed.deleteAccount ? ctx.userId : null });
        if (!deleted) throw new NotFoundError('Workspace not found or access not permitted.');
        const counts = await WorkspaceDeletionRepository.contents(db, ctx.workspaceId);
        await logEvent(ctx, { action: 'WORKSPACE_DELETION_REQUESTED', entityType: 'Workspace', entityId: ctx.workspaceId, details: { ...counts, deleteAccount: parsed.deleteAccount } }, { db });
        return { deletedAt: deleted.deletedAt } as const;
    });
    if ('denied' in outcome) return denyPermission(ctx, 'workspace.delete', {}, { currentRole: outcome.denied ?? null });
    try {
        await (deps.removeJobs ?? defaultJobRemover)(ctx.workspaceId);
    } catch (err) {
        logger.warn('workspace deletion: queued jobs not removed (the purge removes them)', { component: 'workspace-deletion', workspaceId: ctx.workspaceId, error: safeErrorMessage(err) });
    }
    return { workspaceId: ctx.workspaceId, deletedAt: outcome.deletedAt.toISOString(), restorableUntil: workspaceRestorableUntil(outcome.deletedAt).toISOString(), accountDeletionRequested: parsed.deleteAccount };
}

export interface RestorableWorkspaceView {
    workspaceId: string;
    name: string;
    slug: string;
    deletedAt: string;
    restorableUntil: string;
    accountDeletionRequested: boolean;
}

/** The signed-in person's deleted workspaces they hold OWNER in and may still restore (an account route: no workspace context exists for them). */
export async function listRestorableWorkspaces(ctx: UserRequestContext): Promise<{ workspaces: RestorableWorkspaceView[] }> {
    const rows = await runWithoutRls({ reason: 'workspace-deletion-discovery' }, async (db) => {
        const cutoff = workspaceRestoreCutoff(await WorkspaceDeletionRepository.dbNow(db));
        return WorkspaceDeletionRepository.restorableForOwner(db, ctx.userId, cutoff);
    });
    return {
        workspaces: rows.map((w) => ({
            workspaceId: w.id,
            name: w.name,
            slug: w.slug,
            deletedAt: w.deletedAt!.toISOString(),
            restorableUntil: workspaceRestorableUntil(w.deletedAt!).toISOString(),
            accountDeletionRequested: w.purgeAccountOfId !== null,
        })),
    };
}

/**
 * One of its OWNERs restores a deleted workspace, whole, within the window (by the database's clock). Anyone else, a
 * workspace that is not deleted, or one past the window, is the same 404 (a stranger cannot probe). The account
 * deletion asked with it is cancelled. Audited.
 */
export async function restoreWorkspace(ctx: UserRequestContext, workspaceId: unknown): Promise<{ slug: string }> {
    const id = typeof workspaceId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(workspaceId) ? workspaceId : null;
    if (!id) throw new NotFoundError('Workspace not found.');
    const ownerOf = await runWithoutRls({ reason: 'workspace-deletion-discovery' }, async (db) => {
        const cutoff = workspaceRestoreCutoff(await WorkspaceDeletionRepository.dbNow(db));
        return (await WorkspaceDeletionRepository.restorableForOwner(db, ctx.userId, cutoff)).some((w) => w.id === id);
    });
    if (!ownerOf) throw new NotFoundError('Workspace not found.');
    const scope = { workspaceId: id, userId: ctx.userId, requestId: ctx.requestId };
    return runInWorkspaceContext(scope, async (db) => {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'workspace-owner:' + id}))`;
        const me = await MembershipRepository.findForUser(db, id, ctx.userId);
        if (!me || me.role !== 'OWNER') throw new NotFoundError('Workspace not found.');
        const cutoff = workspaceRestoreCutoff(await WorkspaceDeletionRepository.dbNow(db));
        const slug = await WorkspaceDeletionRepository.restore(db, id, cutoff);
        if (!slug) throw new NotFoundError('Workspace not found.');
        await logEvent(scope, { action: 'WORKSPACE_RESTORED', entityType: 'Workspace', entityId: id, details: {} }, { db });
        return { slug };
    });
}

// ─── The purge ──────────────────────────────────────────────────────

/** Workspaces purged at most per run (the next run takes the rest). */
export const WORKSPACE_PURGE_BATCH = 20;
/** A large workspace's cascade deletes hundreds of thousands of rows. */
const PURGE_TX_TIMEOUT_MS = 30 * 60 * 1000;

export interface WorkspacePurgeResult {
    due: number;
    purged: number;
    /** Due when found, but restored (or gone) by the time it was locked. */
    skipped: number;
    failed: number;
    more: boolean;
    accountsDeleted: number;
}

export interface WorkspacePurgeDeps {
    removeJobs?: WorkspaceJobRemover;
    deleteObjects?: (workspaceId: string) => Promise<number>;
    batch?: number;
}

/**
 * The daily purge. For each workspace deleted 30 days ago or more, oldest first: (1) its stored objects are deleted
 * and (2) every job naming it removed — either failing stops THAT workspace's purge (logged, counted, due again
 * tomorrow), because a database row deleted first would leave objects or jobs nothing could find again; then (3) one
 * transaction, outside row-level security as the owning role (app_user may never delete a workspace row): the row is
 * locked only while still due, its contents counted, the row deleted (the cascade takes every workspace-scoped row),
 * the requesting OWNER's account deleted when they asked and hold no other membership, and the purge's
 * `WORKSPACE_PURGED` row appended to the workspace's audit chain under its row-level security.
 */
export async function purgeDeletedWorkspaces(deps: WorkspacePurgeDeps = {}): Promise<WorkspacePurgeResult> {
    const batch = deps.batch ?? WORKSPACE_PURGE_BATCH;
    const removeJobs = deps.removeJobs ?? defaultJobRemover;
    const deleteObjects = deps.deleteObjects ?? ((workspaceId: string) => deleteWorkspaceObjects(workspaceId));
    const due = await runWithoutRls({ reason: 'workspace-deletion-discovery' }, async (db) => {
        const cutoff = workspaceRestoreCutoff(await WorkspaceDeletionRepository.dbNow(db));
        return WorkspaceDeletionRepository.listPurgeDue(db, cutoff, batch + 1);
    });
    const result: WorkspacePurgeResult = { due: Math.min(due.length, batch), purged: 0, skipped: 0, failed: 0, more: due.length > batch, accountsDeleted: 0 };
    for (const ws of due.slice(0, batch)) {
        try {
            const objects = await deleteObjects(ws.id);
            const jobs = await removeJobs(ws.id);
            const purged = await runWithoutRls({ reason: 'workspace-purge' }, (db) =>
                db.$transaction(
                    async (tx) => {
                        const cutoff = workspaceRestoreCutoff(await WorkspaceDeletionRepository.dbNow(tx));
                        const locked = await WorkspaceDeletionRepository.lockPurgeDue(tx, ws.id, cutoff);
                        if (!locked) return null;
                        const counts = await WorkspaceDeletionRepository.contents(tx, ws.id);
                        if ((await WorkspaceDeletionRepository.purge(tx, ws.id, cutoff)) !== 1) return null;
                        let accountDeleted = false;
                        if (locked.purgeAccountOfId && (await WorkspaceDeletionRepository.countMemberships(tx, locked.purgeAccountOfId)) === 0) {
                            accountDeleted = (await WorkspaceDeletionRepository.deleteUser(tx, locked.purgeAccountOfId)) === 1;
                        }
                        // The workspace's own chain records its end (the trail outlives the workspace by design).
                        const requestId = randomUUID();
                        await bindWorkspaceInTransaction(tx, { workspaceId: ws.id, requestId });
                        await appendAuditEntryWithin(tx, {
                            workspaceId: ws.id,
                            actorUserId: null,
                            actorType: 'SYSTEM',
                            action: 'WORKSPACE_PURGED',
                            entityType: 'Workspace',
                            entityId: ws.id,
                            detailsJson: { ...counts, objectsDeleted: objects, jobsRemoved: jobs.removed, jobsActive: jobs.active, accountDeleted },
                            requestId,
                        });
                        return { accountDeleted };
                    },
                    { maxWait: 10_000, timeout: PURGE_TX_TIMEOUT_MS },
                ),
            );
            if (purged) {
                result.purged++;
                if (purged.accountDeleted) result.accountsDeleted++;
                workspaceKeys.clear(ws.id);
            } else {
                result.skipped++;
            }
        } catch (err) {
            result.failed++;
            logger.error('workspace purge failed for one workspace', { component: 'workspace-purge', workspaceId: ws.id, error: safeErrorMessage(err) });
        }
    }
    return result;
}
