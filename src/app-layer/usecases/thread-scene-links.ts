/**
 * THREADS PLANTED AND PAID OFF BY SCENES (Phase 5.3, D35 item 4): the author's decision on a link the nightly draft
 * reading PROPOSED ("this scene plants / pays off this thread", citing the scene's sentence). `bible.edit` decides;
 * once (409 LINK_DECIDED otherwise, nothing written): CONFIRM shows the link on the thread (the Continuity page) and the
 * scene (the editor's side panel); REJECT records the decision, and that thread, scene and role are never proposed
 * again (the unique key). A flagged link (D14) is decided like any other, one by one. A link changes nothing else:
 * the thread's state stays the author's (a confirmed PAYS does not close a promise by itself). Audit last.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { ThreadSceneLinkRepository } from '@/app-layer/repositories/draft-facts.repository';
import { ThreadSceneLinkDecisionInput } from '@/app-layer/schemas/draft';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError } from '@/lib/errors/types';
import type { LinkStatus } from '@/lib/draft-facts/vocabulary';
import { requireBook } from './bible-common';

export async function decideThreadSceneLink(ctx: WorkspaceRequestContext, bookId: string, linkId: string, input: unknown): Promise<{ id: string; status: LinkStatus }> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const parsed = ThreadSceneLinkDecisionInput.parse(input);
        const link = await ThreadSceneLinkRepository.find(db, ctx.workspaceId, bookId, linkId);
        if (!link) throw new NotFoundError('Link not found.');
        if (link.status !== 'PENDING') throw new ConflictError('This link was already decided.', { reason: 'LINK_DECIDED', status: link.status });
        const status = parsed.decision === 'CONFIRM' ? 'CONFIRMED' : 'REJECTED';
        if (!(await ThreadSceneLinkRepository.decide(db, ctx.workspaceId, link.id, { status, decidedById: ctx.userId, at: new Date() }))) {
            throw new ConflictError('This link was already decided.', { reason: 'LINK_DECIDED' });
        }
        // AUDIT LAST (3.H).
        await logEvent(ctx, { action: 'THREAD_SCENE_LINK_DECIDED', entityType: 'StoryThreadSceneLink', entityId: link.id, details: { bookId, threadId: link.threadId, sceneId: link.sceneId, role: link.role, decision: parsed.decision } }, { db });
        return { id: link.id, status };
    });
}
