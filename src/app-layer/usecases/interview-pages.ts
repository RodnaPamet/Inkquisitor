/**
 * What each interview page reads (Phase 2.4), as `bible-pages.ts` does for
 * the bible: one function per page, composing the usecases (each asks its own
 * permission, `bible.view`), reading nothing a page does not show.
 *
 *   loadInterviewsPage      the book and its interviews (newest first, bounded)
 *   loadInterviewPage       the book, the interview as stored, the elements
 *                           its scope covers (names, for the cards and panel),
 *                           the rounds whose reconcile failed or was refused
 *   loadNewInterviewPage    the book and the elements a new interview's scope
 *                           covers (an element the book lacks is a 404)
 *   loadReviewPage          the book and an interview's proposed bible changes (2.5)
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import type { InterviewTarget } from '@/lib/interview/setup';
import { getBook } from './books';
import { getInterview, interviewScopeElements, listInterviews } from './interviews';
import { getSessionReview, listPendingReviews, reconcileRoundsNeedingAttention } from './enrichment-review';

export async function loadInterviewsPage(ctx: WorkspaceRequestContext, bookId: string) {
    const [book, list, pending] = await Promise.all([getBook(ctx, bookId), listInterviews(ctx, bookId), listPendingReviews(ctx, bookId)]);
    // Phase 2.5: how many proposed changes each interview still holds for review.
    return { book, ...list, pendingBySession: Object.fromEntries(pending.map((p) => [p.sessionId, p.pending])) as Record<string, number> };
}

export async function loadInterviewPage(ctx: WorkspaceRequestContext, bookId: string, sessionId: string) {
    const [book, interview, reconcileAttention] = await Promise.all([
        getBook(ctx, bookId),
        getInterview(ctx, bookId, sessionId),
        // Phase 2.H (issue #39 item 6): rounds whose reconcile failed or was refused.
        reconcileRoundsNeedingAttention(ctx, bookId, sessionId),
    ]);
    const s = interview.session;
    const scope =
        s.scope === 'ELEMENT' && s.targetElementId
            ? interviewScopeElements(ctx, bookId, { scope: 'ELEMENT', elementId: s.targetElementId })
            : s.scope === 'KIND' && s.targetKind
              ? interviewScopeElements(ctx, bookId, { scope: 'KIND', kind: s.targetKind })
              : s.scope === 'SELECTION'
                ? interviewScopeElements(ctx, bookId, { scope: 'SELECTION', elementIds: s.scopeElementIds, relationIds: s.scopeRelationIds, frozen: true })
                : s.scope === 'BETWEEN' && s.slot
                  ? interviewScopeElements(ctx, bookId, { scope: 'BETWEEN', afterElementId: s.slot.afterElementId, beforeElementId: s.slot.beforeElementId }).catch(() => ({ elements: [], truncated: false }))
                  : s.scope === 'SCENE' && s.sceneId
                    ? interviewScopeElements(ctx, bookId, { scope: 'SCENE', sceneId: s.sceneId }).catch(() => ({ elements: [], truncated: false }))
                    : interviewScopeElements(ctx, bookId, { scope: 'BOOK' });
    return { book, interview, reconcileAttention, ...(await scope) };
}

export async function loadNewInterviewPage(ctx: WorkspaceRequestContext, bookId: string, target: InterviewTarget) {
    const [book, scope] = await Promise.all([getBook(ctx, bookId), interviewScopeElements(ctx, bookId, target)]);
    return { book, ...scope };
}

/**
 * An interview's review page (Phase 2.5): the book and the session's
 * proposals, each with the current value of what it targets and the answers it
 * cites (`getSessionReview`, `bible.view`).
 */
export async function loadReviewPage(ctx: WorkspaceRequestContext, bookId: string, sessionId: string) {
    const [book, review] = await Promise.all([getBook(ctx, bookId), getSessionReview(ctx, bookId, sessionId)]);
    return { book, review };
}
