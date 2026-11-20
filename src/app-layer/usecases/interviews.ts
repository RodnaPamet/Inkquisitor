/**
 * Interviews of a book's bible (Phase 2.2): start one, read them, generate
 * the next round, close a round, stop.
 *
 * Permissions: `bible.edit` runs an interview (start, next round, close,
 * stop, and the answers in `interview-answers.ts`), because an interview is
 * how the bible is written to (2.5 turns its answers into accepted bible
 * changes); `bible.view` reads interviews, which every member holds, as they
 * read the bible itself. The questions and answers are author text: a
 * reader of the book may read them, as they may read the bible.
 *
 * A session's lifecycle:
 *
 *   start        ACTIVE, round 1 generated (or, when the scope already has
 *                nothing to ask at its depth, COMPLETED at once with the
 *                reason — no model needed for that)
 *   close round  every question has a status (`skipUnanswered` records SKIPPED
 *                for the rest, the author's own act); the round is CLOSED and
 *                the frontier recomputed: the session ends here when nothing
 *                is left to ask or its rounds are spent, and says which
 *   next round   generates the next round (a PAUSED session resumes here)
 *   stop         STOPPED, AUTHOR_STOPPED; every answer given is kept
 *
 * A request that needs the model (start, next round) calls it through 2.1
 * (`src/lib/interview/model-seam.ts`), under this module's own `bible.edit`
 * check: a model call needs no permission of its own. When the deployment's
 * configuration can make no call (no key, ambient SDK headers, no declared
 * retention mode) it refuses 503 `AI_UNAVAILABLE` naming the reason, before
 * writing anything; the kill switch and the spend ceiling pause the session
 * with KILL_SWITCH / WORKSPACE_CEILING, unless nothing is left to ask, when it
 * completes. Nothing here fakes model output.
 *
 * Since 2.3 a session's dials are resolved from its request and the book's and
 * workspace's defaults (`interview-defaults.ts`), several personas may question
 * it (STORM's perspectives: each words its share of a round, tagged with its
 * name), and the packs it mounts are pinned when it starts and compared before
 * every round (`src/lib/interview/pack-mount.ts`): a pack that does not mount
 * refuses 503 `PACKS_NOT_MOUNTABLE` before anything is written, and a pinned
 * pack whose file changed pauses the session `PACK_CHANGED`.
 *
 * A scope with no element (a kind the book has none of) is refused 400
 * `SCOPE_EMPTY`: a session over nothing would "complete" having asked
 * nothing, and zero is never complete (rule 6).
 */
import type { BibleElementKind, Prisma } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository } from '@/app-layer/repositories/bible.repository';
import { AnswerRepository, InterviewRoundRepository, InterviewSessionRepository, QuestionRepository, type SessionRow } from '@/app-layer/repositories/interview.repository';
import { CloseRoundInput, InterviewStartInput, RoundNumberParam } from '@/app-layer/schemas/interview';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { BIBLE_KINDS, type BibleKind } from '@/lib/bible/kinds';
import { resolveDials } from '@/lib/interview/dial-settings';
import { roundBudgetFor, tokenBudgetFor } from '@/lib/interview/dials';
import { getPacks } from '@/lib/interview/packs';
import { PacksNotMountableError, packNamesFor, pinForRow, pinsFor } from '@/lib/interview/pack-mount';
import { requireBook, requireElement } from './bible-common';
import { defaultLayersFor } from './interview-defaults';
import { deploymentPackMounts } from './interview-packs';
import {
    announceClaim,
    claimRound,
    endSession,
    generateClaimedRound,
    generatorOf,
    stopNow,
    type InterviewDeps,
    type PackContext,
} from './interview-rounds';
import { skipUnanswered } from './interview-answers';
import {
    interviewView,
    latestAnswers,
    loadInterviewState,
    requireSession,
    sessionSummaryView,
    SESSION_ANSWERS_MAX,
    SESSION_QUESTIONS_MAX,
    SESSION_ROUNDS_READ,
    SCOPE_ELEMENTS_MAX,
    type InterviewView,
    type SessionSummaryView,
} from './interview-state';

export type { InterviewDeps } from './interview-rounds';

/** A book's interviews listed at most. */
export const INTERVIEW_LIST_MAX = 100;

function assertNotEnded(session: SessionRow): void {
    if (session.status === 'COMPLETED' || session.status === 'STOPPED') {
        throw new ConflictError('This interview has ended.', { reason: 'INTERVIEW_ENDED', status: session.status, stopReason: session.stopReason });
    }
}

async function viewOf(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sessionId: string): Promise<InterviewView> {
    const session = await requireSession(db, ctx, bookId, sessionId);
    const state = await loadInterviewState(db, ctx, session);
    return interviewView(session, state);
}

/** The registry and its verdicts a request runs on: the one handed in (tests), else the deployment's. */
function packContextOf(deps: InterviewDeps): PackContext {
    const registry = deps.packs ?? getPacks();
    return { registry, mounts: (names) => deploymentPackMounts(registry, deps.packRecordMode, names) };
}

/**
 * Start an interview. Its dials are resolved once, here, and stored on the
 * session: the request's own, then the book's defaults, then the workspace's,
 * then the code default (`resolveDials`). Every pack it will mount — the
 * craft pack of each kind in scope (every kind, for a book) and each persona's
 * — is pinned on the session by content hash, or the start is refused 503
 * `PACKS_NOT_MOUNTABLE` with nothing written.
 */
export async function startInterview(ctx: WorkspaceRequestContext, bookId: string, input: unknown, deps: InterviewDeps = {}): Promise<InterviewView> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = InterviewStartInput.parse(input);
    const generator = generatorOf(ctx, deps);
    // Before anything is written: a pack that will not load fails the request
    // here, not after a round has been claimed and left generating.
    const packContext = packContextOf(deps);
    deps = { ...deps, packs: packContext.registry };

    const started = await runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        let kinds: BibleKind[];
        if (parsed.scope === 'ELEMENT') kinds = [(await requireElement(db, ctx, bookId, parsed.elementId!)).kind];
        else {
            const any = await BibleElementRepository.listForInterview(db, ctx.workspaceId, bookId, { kind: parsed.kind, take: 1 });
            if (any.length === 0) throw new ValidationError('There is nothing in this book to ask about yet.', { reason: 'SCOPE_EMPTY' });
            kinds = parsed.scope === 'KIND' ? [parsed.kind!] : [...BIBLE_KINDS];
        }
        const { settings, sources } = resolveDials({ session: parsed, ...(await defaultLayersFor(db, ctx, bookId)) });
        const names = packNamesFor(kinds, settings.personaKeys);
        const pinned = pinsFor(names, await packContext.mounts(names));
        if (!pinned.ok) throw new PacksNotMountableError(pinned.refusals);
        const { depth, detail, personaKeys } = settings;
        const session = await InterviewSessionRepository.create(db, ctx.workspaceId, {
            bookId,
            scope: parsed.scope,
            targetElementId: parsed.scope === 'ELEMENT' ? parsed.elementId! : null,
            targetKind: parsed.scope === 'KIND' ? parsed.kind! : null,
            depth,
            detail,
            personaKeys,
            offerRecommended: settings.offerRecommended,
            preferChoice: settings.preferChoice,
            roundBudget: roundBudgetFor(depth),
            tokenBudget: tokenBudgetFor(depth, personaKeys.length),
            packPins: pinned.pins.map(pinForRow) as unknown as Prisma.InputJsonValue,
            createdById: ctx.userId,
        });
        await logEvent(
            ctx,
            {
                action: 'INTERVIEW_STARTED',
                entityType: 'InterviewSession',
                entityId: session.id,
                details: {
                    bookId,
                    scope: parsed.scope,
                    targetElementId: session.targetElementId,
                    targetKind: session.targetKind,
                    depth,
                    detail,
                    personaKeys,
                    offerRecommended: settings.offerRecommended,
                    preferChoice: settings.preferChoice,
                    dialSources: sources,
                    packs: pinned.pins.map((p) => `${p.name}@${p.version}`),
                },
            },
            { db },
        );
        return { session, claim: await claimRound(db, ctx, session, generator, packContext) };
    });
    deps.stream?.emit({ type: 'started', sessionId: started.session.id });
    announceClaim(deps, started.claim);
    if (started.claim.kind === 'claimed') await generateClaimedRound(ctx, started.session, started.claim, deps);
    return runInWorkspaceContext(ctx, (db) => viewOf(db, ctx, bookId, started.session.id));
}

export async function listInterviews(ctx: WorkspaceRequestContext, bookId: string): Promise<{ sessions: SessionSummaryView[]; truncated: boolean }> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const rows = await InterviewSessionRepository.listForBook(db, ctx.workspaceId, bookId, INTERVIEW_LIST_MAX + 1);
        const listed = rows.slice(0, INTERVIEW_LIST_MAX);
        // The element sessions' element names, in one read (Phase 2.4: the list names what each interview asked about).
        const elementIds = [...new Set(listed.map((s) => s.targetElementId).filter((id): id is string => id !== null))];
        const names = new Map((await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, elementIds)).map((e) => [e.id, e.name] as const));
        return {
            sessions: listed.map((s) => sessionSummaryView(s, s.targetElementId ? (names.get(s.targetElementId) ?? null) : null)),
            truncated: rows.length > INTERVIEW_LIST_MAX,
        };
    });
}

export async function getInterview(ctx: WorkspaceRequestContext, bookId: string, sessionId: string): Promise<InterviewView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        return viewOf(db, ctx, bookId, sessionId);
    });
}

/** An element an interview may ask about, as its page names it (Phase 2.4): no stored value. */
export interface ScopeElementView {
    id: string;
    name: string;
    kind: BibleElementKind;
}

/**
 * The elements a scope covers, for the interview page to name them (Phase
 * 2.4; `bible.view`): one element, one kind's, or the book's, at most
 * `SCOPE_ELEMENTS_MAX` (the engine's own bound; `truncated` beyond it). An
 * element the book does not hold is a 404.
 */
export async function interviewScopeElements(
    ctx: WorkspaceRequestContext,
    bookId: string,
    scope: { scope: 'ELEMENT'; elementId: string } | { scope: 'KIND'; kind: BibleElementKind } | { scope: 'BOOK' },
): Promise<{ elements: ScopeElementView[]; truncated: boolean }> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        if (scope.scope === 'ELEMENT') {
            const e = await requireElement(db, ctx, bookId, scope.elementId);
            return { elements: [{ id: e.id, name: e.name, kind: e.kind }], truncated: false };
        }
        const rows = await BibleElementRepository.listForInterview(db, ctx.workspaceId, bookId, { kind: scope.scope === 'KIND' ? scope.kind : undefined, take: SCOPE_ELEMENTS_MAX + 1 });
        return { elements: rows.slice(0, SCOPE_ELEMENTS_MAX).map((e) => ({ id: e.id, name: e.name, kind: e.kind })), truncated: rows.length > SCOPE_ELEMENTS_MAX };
    });
}

/** Generate the session's next round (a paused session resumes). */
export async function nextRound(ctx: WorkspaceRequestContext, bookId: string, sessionId: string, deps: InterviewDeps = {}): Promise<InterviewView> {
    await assertPermission(ctx, 'bible.edit');
    const generator = generatorOf(ctx, deps);
    const packContext = packContextOf(deps);
    deps = { ...deps, packs: packContext.registry };
    const claimed = await runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await InterviewSessionRepository.lock(db, sessionId);
        const session = await requireSession(db, ctx, bookId, sessionId);
        assertNotEnded(session);
        return { session, claim: await claimRound(db, ctx, session, generator, packContext) };
    });
    announceClaim(deps, claimed.claim);
    if (claimed.claim.kind === 'claimed') await generateClaimedRound(ctx, claimed.session, claimed.claim, deps);
    return runInWorkspaceContext(ctx, (db) => viewOf(db, ctx, bookId, sessionId));
}

/**
 * Close the session's open round `roundNumber`. Every question needs a
 * status: an unanswered one refuses 409 `ROUND_HAS_UNANSWERED`, unless
 * `skipUnanswered`, which records a SKIPPED answer for each (the author's own
 * act). Then the session stops if nothing is left to ask or its rounds are
 * spent, and says which.
 */
export async function closeRound(ctx: WorkspaceRequestContext, bookId: string, sessionId: string, roundNumberParam: string, input: unknown): Promise<InterviewView> {
    await assertPermission(ctx, 'bible.edit');
    const roundNumber = RoundNumberParam.parse(roundNumberParam);
    const parsed = CloseRoundInput.parse(input ?? {});
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await InterviewSessionRepository.lock(db, sessionId);
        const session = await requireSession(db, ctx, bookId, sessionId);
        assertNotEnded(session);
        const round = await InterviewRoundRepository.findByNumber(db, ctx.workspaceId, sessionId, roundNumber);
        if (!round) throw new NotFoundError('Round not found.');
        if (round.status !== 'OPEN') throw new ConflictError('That round is not open.', { reason: 'ROUND_NOT_OPEN', status: round.status });

        // The questions the round ASKS: one a rephrase replaced waits for nothing (Phase 2.4).
        const questions = (await QuestionRepository.listForRound(db, ctx.workspaceId, sessionId, round.id, SESSION_QUESTIONS_MAX)).filter((q) => q.supersededAt === null);
        const latest = latestAnswers(await AnswerRepository.listForSession(db, ctx.workspaceId, sessionId, SESSION_ANSWERS_MAX));
        const unanswered = questions.filter((q) => !latest.has(q.id));
        if (unanswered.length > 0 && !parsed.skipUnanswered) {
            throw new ConflictError('Some questions of this round have no answer yet.', { reason: 'ROUND_HAS_UNANSWERED', unanswered: unanswered.length });
        }
        await skipUnanswered(db, ctx, sessionId, unanswered.map((q) => q.id));
        await InterviewRoundRepository.update(db, ctx.workspaceId, round.id, { status: 'CLOSED', closedAt: new Date() });
        await InterviewSessionRepository.update(db, ctx.workspaceId, sessionId, { roundsRun: session.roundsRun + 1 });
        await logEvent(
            ctx,
            {
                action: 'INTERVIEW_ROUND_CLOSED',
                entityType: 'InterviewRound',
                entityId: round.id,
                details: { sessionId, roundNumber, questionCount: questions.length, skippedAtClose: unanswered.length },
            },
            { db },
        );

        const after = await requireSession(db, ctx, bookId, sessionId);
        const state = await loadInterviewState(db, ctx, after);
        const stop = stopNow(after, state);
        if (stop) await endSession(db, ctx, after, stop.reason, stop.detail);
        return viewOf(db, ctx, bookId, sessionId);
    });
}

/** The author stops: every answer given is kept; a round in flight is closed as it stands. */
export async function stopInterview(ctx: WorkspaceRequestContext, bookId: string, sessionId: string): Promise<InterviewView> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await InterviewSessionRepository.lock(db, sessionId);
        const session = await requireSession(db, ctx, bookId, sessionId);
        assertNotEnded(session);
        // The open or generating round, if any, is the newest: the latest rounds hold it.
        const rounds = await InterviewRoundRepository.listForSession(db, ctx.workspaceId, sessionId, SESSION_ROUNDS_READ);
        let roundsRun = session.roundsRun;
        for (const r of rounds) {
            if (r.status === 'OPEN') {
                await InterviewRoundRepository.update(db, ctx.workspaceId, r.id, { status: 'CLOSED', closedAt: new Date() });
                roundsRun += 1;
            } else if (r.status === 'GENERATING') {
                await InterviewRoundRepository.update(db, ctx.workspaceId, r.id, { status: 'FAILED' });
            }
        }
        if (roundsRun !== session.roundsRun) await InterviewSessionRepository.update(db, ctx.workspaceId, sessionId, { roundsRun });
        await endSession(db, ctx, { ...session, roundsRun }, 'AUTHOR_STOPPED', { roundsRun });
        return viewOf(db, ctx, bookId, sessionId);
    });
}
