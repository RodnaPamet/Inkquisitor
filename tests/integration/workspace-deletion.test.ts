/**
 * Full deletion within 30 days (Phase 5.H-a, D36; roadmap 5.H item 4), against a real database, Redis and storage:
 *
 *   - an OWNER asks, naming the workspace exactly (409 NAME_MISMATCH otherwise; an EDITOR is refused, audited);
 *     the workspace closes AT ONCE (the gate finds it missing for every member) and its queued jobs are removed;
 *   - an OWNER restores it from their account within the window, whole; a stranger cannot (404);
 *   - after 30 days the daily purge deletes it: ZERO rows of it remain in EVERY workspace-scoped table (enumerated
 *     from the Prisma schema, not a hand list), nothing under `workspaces/<id>/` in storage, no job naming it — and
 *     the requesting OWNER's account when they asked and belong to no other workspace. The one table kept is the
 *     audit trail (no foreign key, by design), whose chain still verifies and ends with WORKSPACE_PURGED;
 *   - the database refuses app_user's delete of a workspace row, whatever its state.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { resolveWorkspaceMembership } from '@/app-layer/context';
import { closeQueue, enqueue, getQueue, removeWorkspaceJobs } from '@/app-layer/jobs/queue';
import { createBook, deleteBook } from '@/app-layer/usecases/books';
import { createElement, updateElementFields } from '@/app-layer/usecases/bible-elements';
import { createChapter, createScene, deleteScene } from '@/app-layer/usecases/manuscript';
import { saveSceneText, updateSceneMeta } from '@/app-layer/usecases/manuscript-scenes';
import { getStoryMap, saveStoryMap } from '@/app-layer/usecases/story-maps';
import { listRestorableWorkspaces, purgeDeletedWorkspaces, requestWorkspaceDeletion, restoreWorkspace } from '@/app-layer/usecases/workspace-deletion';
import { verifyAuditChain } from '@/lib/audit/audit-writer';
import { buildWorkspaceObjectKey, getStorageProvider } from '@/lib/storage';
import { ForbiddenError, NotFoundError } from '@/lib/errors/types';
import { parseSchemaModels } from '../helpers/prisma-schema-models';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';

const queueName = `inkquisitor-wsdel-test-${process.pid}-${Date.now()}`;
const removeJobs = (workspaceId: string) => removeWorkspaceJobs(workspaceId, { queueName });

afterAll(async () => {
    await getQueue(queueName).obliterate({ force: true }).catch(() => undefined);
    await closeQueue();
    await prisma.$disconnect();
});

/** Every workspace-scoped table, from the schema: each model with a `workspaceId` column, and `Workspace` itself. */
const SCOPED = parseSchemaModels().filter((m) => m.scalarFieldNames.includes('workspaceId'));
/** The ONE table the purge keeps (docs/your-data.md): the hash-chained audit trail, which has no foreign key by design. */
const KEPT = new Set(['AuditLog']);

async function rowsOf(workspaceId: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    await runWithoutRls({ reason: 'test' }, async (db) => {
        for (const m of SCOPED) {
            const [{ n }] = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${m.tableName}" WHERE "workspaceId" = $1`, workspaceId);
            out[m.tableName] = n;
        }
        out.Workspace = await db.workspace.count({ where: { id: workspaceId } });
    });
    return out;
}

/** A workspace holding a spread of everything: books (one in Recently deleted), a bible with versions, a manuscript with a deleted scene, a map. */
async function populated() {
    const owner = await createAccount();
    const ctx = workspaceCtx(owner);
    const book = await createBook(ctx, { title: 'The Salt Roads' });
    const mara = await createElement(ctx, book.id, { kind: 'CHARACTER', name: 'Mara' });
    await updateElementFields(ctx, book.id, mara.id, { fields: [{ key: 'want', value: 'To reach the cape.' }], baseVersion: mara.versionNumber });
    const beat = await createElement(ctx, book.id, { kind: 'PLOT_BEAT', name: 'The fog' });
    const chapter = await createChapter(ctx, book.id, { title: 'One' });
    const kept = (await createScene(ctx, book.id, { chapterId: chapter.id, title: 'Kept' })).id;
    const saved = await saveSceneText(ctx, book.id, kept, { html: '<p>Mara at the rail.</p>', baseRevision: 0 }, { enqueueProseCheck: async () => undefined });
    await updateSceneMeta(ctx, book.id, kept, { baseRevision: saved.revision, beatElementIds: [beat.id], linkedElementIds: [mara.id] });
    const doomed = (await createScene(ctx, book.id, { chapterId: chapter.id, title: 'Doomed' })).id;
    await deleteScene(ctx, book.id, doomed);
    const map = await getStoryMap(ctx, book.id, 'plot');
    await saveStoryMap(ctx, book.id, 'plot', { expectedVersion: map.version, nodes: [{ elementId: beat.id, x: 0, y: 0, w: 200, h: 88, lane: null }], edges: [], freeform: [] });
    const other = await createBook(ctx, { title: 'Draft two' });
    await deleteBook(ctx, other.id);
    return { owner, ctx };
}

async function backdate(workspaceId: string, days = 31) {
    await runWithoutRls({ reason: 'test' }, (db) => db.$executeRaw`UPDATE "Workspace" SET "deletedAt" = (now() AT TIME ZONE 'UTC') - make_interval(days => ${days}) WHERE "id" = ${workspaceId}`);
}

describe('asking for the deletion', () => {
    it('needs the OWNER and the exact name; closes the workspace at once and removes its queued jobs', async () => {
        const { owner, ctx } = await populated();
        const editor = await createBareUser();
        await addMember(owner.workspaceId, editor.id, 'EDITOR');
        await expect(requestWorkspaceDeletion(workspaceCtx({ ...owner, userId: editor.id }, 'EDITOR'), { confirmName: 'x' })).rejects.toBeInstanceOf(ForbiddenError);
        const name = (await prisma.workspace.findUniqueOrThrow({ where: { id: owner.workspaceId } })).name;
        await expect(requestWorkspaceDeletion(ctx, { confirmName: `${name} ` + 'not it' }, { removeJobs })).rejects.toMatchObject({ details: { reason: 'NAME_MISMATCH' } });

        await enqueue('prose-check', { workspaceId: owner.workspaceId, sceneId: 'sc_x' }, { queueName, delay: 600_000 });
        await enqueue('prose-check', { workspaceId: 'someone-else', sceneId: 'sc_y' }, { queueName, delay: 600_000 });
        const view = await requestWorkspaceDeletion(ctx, { confirmName: `  ${name} ` }, { removeJobs });
        expect(new Date(view.restorableUntil).getTime() - new Date(view.deletedAt).getTime()).toBe(30 * 24 * 60 * 60 * 1000);
        // Closed to every member at once: the gate finds no workspace.
        expect(await resolveWorkspaceMembership(owner.userId, owner.workspaceSlug)).toBeNull();
        expect(await resolveWorkspaceMembership(editor.id, owner.workspaceSlug)).toBeNull();
        const left = (await getQueue(queueName).getJobs(['delayed'], 0, 100)).map((j) => (j.data as { workspaceId: string }).workspaceId);
        expect(left).toEqual(['someone-else']);
        // The deletion's time is the database's clock (app_user's stamp).
        const [{ skew }] = await prisma.$queryRaw<Array<{ skew: number }>>`SELECT abs(extract(epoch FROM ("deletedAt" - (now() AT TIME ZONE 'UTC'))))::float AS "skew" FROM "Workspace" WHERE "id" = ${owner.workspaceId}`;
        expect(skew).toBeLessThan(60);
    });

    it('refuses to delete an account that belongs to another workspace too', async () => {
        const a = await createAccount();
        const b = await createAccount();
        await addMember(b.workspaceId, a.userId, 'READER');
        const name = (await prisma.workspace.findUniqueOrThrow({ where: { id: a.workspaceId } })).name;
        await expect(requestWorkspaceDeletion(workspaceCtx(a), { confirmName: name, deleteAccount: true }, { removeJobs })).rejects.toMatchObject({ details: { reason: 'ACCOUNT_HAS_OTHER_WORKSPACES' } });
    });

    it('app_user can never delete a workspace row', async () => {
        const a = await createAccount();
        await expect(runInWorkspaceContext({ workspaceId: a.workspaceId, requestId: randomUUID() }, (db) => db.workspace.deleteMany({ where: { id: a.workspaceId } }))).rejects.toThrow(/WORKSPACE_DELETE_BY_PURGE_ONLY/);
    });
});

describe('restoring it', () => {
    it('an OWNER restores it whole within the window; a stranger, or past the window, cannot', async () => {
        const { owner, ctx } = await populated();
        const before = await rowsOf(owner.workspaceId);
        const name = (await prisma.workspace.findUniqueOrThrow({ where: { id: owner.workspaceId } })).name;
        await requestWorkspaceDeletion(ctx, { confirmName: name, deleteAccount: true }, { removeJobs });
        const ownerCtx = { requestId: randomUUID(), userId: owner.userId };
        expect((await listRestorableWorkspaces(ownerCtx)).workspaces).toEqual([expect.objectContaining({ workspaceId: owner.workspaceId, name, accountDeletionRequested: true })]);
        const stranger = await createAccount();
        await expect(restoreWorkspace({ requestId: randomUUID(), userId: stranger.userId }, owner.workspaceId)).rejects.toBeInstanceOf(NotFoundError);
        expect((await restoreWorkspace(ownerCtx, owner.workspaceId)).slug).toBe(owner.workspaceSlug);
        expect(await resolveWorkspaceMembership(owner.userId, owner.workspaceSlug)).not.toBeNull();
        const after = await rowsOf(owner.workspaceId);
        // Whole: every table holds what it held (the audit trail gained the two rows that record it).
        expect({ ...after, AuditLog: 0 }).toEqual({ ...before, AuditLog: 0 });
        expect(await prisma.workspace.findUniqueOrThrow({ where: { id: owner.workspaceId }, select: { purgeAccountOfId: true, deletedAt: true } })).toEqual({ purgeAccountOfId: null, deletedAt: null });

        await requestWorkspaceDeletion(ctx, { confirmName: name }, { removeJobs });
        await backdate(owner.workspaceId);
        await expect(restoreWorkspace(ownerCtx, owner.workspaceId)).rejects.toBeInstanceOf(NotFoundError);
    });
});

describe('the purge, 30 days on', () => {
    it('leaves ZERO rows of the workspace in every workspace-scoped table, nothing in storage, no job; keeps the audit chain', async () => {
        const { owner, ctx } = await populated();
        const neighbour = await populated();
        const before = await rowsOf(owner.workspaceId);
        // The fixture is not empty where it matters (a purge over nothing proves nothing).
        for (const t of ['Book', 'BibleElement', 'BibleEntryVersion', 'ManuscriptScene', 'SceneVersion', 'SceneElementLink', 'SceneBeatLink', 'MapSnapshot', 'WorkspaceMembership']) expect(before[t]).toBeGreaterThan(0);
        expect(SCOPED.length).toBeGreaterThanOrEqual(60);

        const storage = getStorageProvider();
        const key = buildWorkspaceObjectKey(owner.workspaceId, 'exports', 'archive.zip');
        await storage.write(key, Buffer.from('an object of the workspace'));
        const neighbourKey = buildWorkspaceObjectKey(neighbour.owner.workspaceId, 'exports', 'archive.zip');
        await storage.write(neighbourKey, Buffer.from('a neighbour’s object'));

        const name = (await prisma.workspace.findUniqueOrThrow({ where: { id: owner.workspaceId } })).name;
        await requestWorkspaceDeletion(ctx, { confirmName: name, deleteAccount: true }, { removeJobs });
        // Not due yet: the purge leaves it.
        await purgeDeletedWorkspaces({ removeJobs });
        expect((await rowsOf(owner.workspaceId)).Workspace).toBe(1);

        await enqueue('prose-check', { workspaceId: owner.workspaceId, sceneId: 'sc_late' }, { queueName, delay: 600_000 });
        await backdate(owner.workspaceId);
        const result = await purgeDeletedWorkspaces({ removeJobs });
        expect(result).toMatchObject({ failed: 0 });
        expect(result.purged).toBeGreaterThanOrEqual(1);

        const after = await rowsOf(owner.workspaceId);
        const notEmpty = Object.entries(after).filter(([t, n]) => n > 0 && !KEPT.has(t));
        expect(notEmpty).toEqual([]);
        // The neighbour is untouched.
        expect(await rowsOf(neighbour.owner.workspaceId)).toEqual(expect.objectContaining({ Workspace: 1, Book: expect.any(Number) }));
        expect((await rowsOf(neighbour.owner.workspaceId)).Book).toBeGreaterThan(0);
        // Storage: nothing under the workspace's prefix; the neighbour's object stands.
        await expect(storage.head(key)).rejects.toThrow();
        await expect(storage.head(neighbourKey)).resolves.toMatchObject({ sizeBytes: expect.any(Number) });
        await storage.delete(neighbourKey);
        // Jobs: none names it.
        const named = (await getQueue(queueName).getJobs(['delayed', 'waiting', 'completed', 'failed'], 0, 500)).filter((j) => (j.data as { workspaceId?: string }).workspaceId === owner.workspaceId);
        expect(named).toEqual([]);
        // The account: deleted, as asked, since it belonged to no other workspace.
        expect(await prisma.user.count({ where: { id: owner.userId } })).toBe(0);
        // The audit trail is the one thing kept: its chain verifies and ends with the purge.
        expect((await verifyAuditChain(owner.workspaceId)).valid).toBe(true);
        const last = await prisma.auditLog.findFirst({ where: { workspaceId: owner.workspaceId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { action: true, detailsJson: true } });
        expect(last).toMatchObject({ action: 'WORKSPACE_PURGED', detailsJson: { accountDeleted: true, objectsDeleted: 1 } });
    });

    it('keeps the account of a requester who joined another workspace meanwhile', async () => {
        const a = await createAccount();
        const name = (await prisma.workspace.findUniqueOrThrow({ where: { id: a.workspaceId } })).name;
        await requestWorkspaceDeletion(workspaceCtx(a), { confirmName: name, deleteAccount: true }, { removeJobs });
        const b = await createAccount();
        await addMember(b.workspaceId, a.userId, 'READER');
        await backdate(a.workspaceId);
        await purgeDeletedWorkspaces({ removeJobs });
        expect(await prisma.workspace.count({ where: { id: a.workspaceId } })).toBe(0);
        expect(await prisma.user.count({ where: { id: a.userId } })).toBe(1);
    });
});
