/**
 * What each interview page reads (Phase 2.4), as `bible-pages.ts` does for
 * the bible: one function per page, composing the usecases (each asks its own
 * permission, `bible.view`), reading nothing a page does not show.
 *
 *   loadInterviewsPage      the book and its interviews (newest first, bounded)
 *   loadInterviewPage       the book, the interview as stored, the elements
 *                           its scope covers (names, for the cards and panel)
 *   loadNewInterviewPage    the book and the elements a new interview's scope
 *                           covers (an element the book lacks is a 404)
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import type { InterviewTarget } from '@/lib/interview/setup';
import { getBook } from './books';
import { getInterview, interviewScopeElements, listInterviews } from './interviews';

export async function loadInterviewsPage(ctx: WorkspaceRequestContext, bookId: string) {
    const [book, list] = await Promise.all([getBook(ctx, bookId), listInterviews(ctx, bookId)]);
    return { book, ...list };
}

export async function loadInterviewPage(ctx: WorkspaceRequestContext, bookId: string, sessionId: string) {
    const [book, interview] = await Promise.all([getBook(ctx, bookId), getInterview(ctx, bookId, sessionId)]);
    const s = interview.session;
    const scope =
        s.scope === 'ELEMENT' && s.targetElementId
            ? interviewScopeElements(ctx, bookId, { scope: 'ELEMENT', elementId: s.targetElementId })
            : s.scope === 'KIND' && s.targetKind
              ? interviewScopeElements(ctx, bookId, { scope: 'KIND', kind: s.targetKind })
              : interviewScopeElements(ctx, bookId, { scope: 'BOOK' });
    return { book, interview, ...(await scope) };
}

export async function loadNewInterviewPage(ctx: WorkspaceRequestContext, bookId: string, target: InterviewTarget) {
    const [book, scope] = await Promise.all([getBook(ctx, bookId), interviewScopeElements(ctx, bookId, target)]);
    return { book, ...scope };
}
