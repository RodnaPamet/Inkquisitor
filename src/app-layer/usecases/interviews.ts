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
 *
 * Phase 3.3 (the canvas): a SELECTION session asks about the elements and
 * relations selected on a map (and every relation between the selected
 * elements), a BETWEEN session about a beat not yet created between two
 * neighbouring beats; both resolved and frozen at start (`interview-scope.ts`).
 */
import type { BibleElementKind, Prisma } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository } from '@/app-layer/repositories/bible.repository';
import { AnswerRepository, InterviewRoundRepository, InterviewSessionRepository, QuestionRepository, type SessionRow } from '@/app-layer/repositories/interview.repository';
import { CloseRoundInput, InterviewStartInput, NextRoundInput, RoundNumberParam } from '@/app-layer/schemas/interview';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { BIBLE_KINDS, type BibleKind } from '@/lib/bible/kinds';
import { resolveDials } from '@/lib/interview/dial-settings';
import { DEFAULT_SESSION_LENGTH, lengthColumns, tokenBudgetFor, type SessionLength } from '@/lib/interview/session-length';
import { generatorsOn } from '@/lib/interview/dial-settings';
import { getPacks } from '@/lib/interview/packs';
import { PacksNotMountableError, packNamesFor, pinForRow, pinsFor } from '@/lib/interview/pack-mount';
import { requireBook, requireElement } from './bible-common';
import { resolveBetweenSlot, resolveSelection, SLOT_KIND, type BetweenSlot, type SelectionScope } from './interview-scope';
import { BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
import { getRelationType, relationFieldDefs } from '@/lib/bible/templates';
import { PENDING_SUBJECT_ID, relationSubjectName } from '@/lib/interview/subjects';
import { defaultLayersFor } from './interview-defaults';
import { StaleFlagRepository } from '@/app-layer/repositories/continuity.repository';
import { standingStaleFlags } from './stale-flags';
import { deploymentPackMounts } from './interview-packs';
import { requireStressTestForSession } from './stress-tests';
import {
    announceClaim,
    claimRound,
    contextEmbedderOf,
    endSession,
    generateClaimedRound,
    generatorOf,
    planSession,
    stopNow,
    type InterviewDeps,
    type PackContext,
} from './interview-rounds';
import { skipUnanswered } from './interview-answers';
import { decideFactsFromRound } from './source-facts';
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
    SCOPE_RELATIONS_MAX,
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

/** A stale flag a grill session may start from: the book's, OPEN, not yet cleared by a save, about `elementId`. */
async function requireStandingFlag(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, flagId: string, elementId: string | undefined): Promise<void> {
    const flag = await StaleFlagRepository.find(db, ctx.workspaceId, bookId, flagId);
    if (!flag) throw new NotFoundError('Flag not found.');
    const { standing } = await standingStaleFlags(db, ctx.workspaceId, flag.status === 'OPEN' ? [flag] : []);
    if (standing.length === 0 || flag.elementId !== elementId) throw new ConflictError('This entry is no longer flagged as possibly stale.', { reason: 'STALE_FLAG_GONE' });
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
        let selection: SelectionScope | null = null;
        let slot: BetweenSlot | null = null;
        if (parsed.scope === 'ELEMENT') kinds = [(await requireElement(db, ctx, bookId, parsed.elementId!)).kind];
        else if (parsed.scope === 'SELECTION') {
            selection = await resolveSelection(db, ctx, bookId, { elementIds: parsed.elementIds, relationIds: parsed.relationIds });
            kinds = selection.kinds;
            // Phase 4.2 (D28): "Grill me on what changed" — the flag must stand for this very element, still open.
            if (parsed.staleFlagId) await requireStandingFlag(db, ctx, bookId, parsed.staleFlagId, selection.elementIds[0]);
            // Phase 4.3 (D29): a session from a stress test asks about its weak points' elements, and nothing else.
            if (parsed.stressTestId) {
                const test = await requireStressTestForSession(db, ctx, bookId, parsed.stressTestId);
                if (selection.elementIds.length === 0 || selection.elementIds.some((id) => !test.elementIds.includes(id))) {
                    throw new ConflictError('Those elements are not what this stress test asks about.', { reason: 'STRESS_SCOPE_MISMATCH' });
                }
            }
        } else if (parsed.scope === 'BETWEEN') {
            slot = await resolveBetweenSlot(db, ctx, bookId, parsed.afterElementId!, parsed.beforeElementId!);
            kinds = [slot.kind];
        } else {
            const any = await BibleElementRepository.listForInterview(db, ctx.workspaceId, bookId, { kind: parsed.kind, take: 1 });
            if (any.length === 0) throw new ValidationError('There is nothing in this book to ask about yet.', { reason: 'SCOPE_EMPTY' });
            kinds = parsed.scope === 'KIND' ? [parsed.kind!] : [...BIBLE_KINDS];
        }
        // A grill on what changed asks at the deepest level, so the stale fields can be challenged (`interview-rounds.ts`).
        const { settings, sources } = resolveDials({ session: parsed.staleFlagId ? { ...parsed, depth: 5 } : parsed, ...(await defaultLayersFor(db, ctx, bookId)) });
        // A selection with a relation in it is questioned with the relations pack too (Phase 3.3). Phase 4.4 (D30): so is
        // a KIND or BOOK session with the relations generator on, whose relations between two of its elements are
        // subjects too — when the pack mounts here; when it does not, the session starts without those subjects.
        let relations = (selection?.relationIds.length ?? 0) > 0;
        if (!relations && (parsed.scope === 'KIND' || parsed.scope === 'BOOK') && generatorsOn(settings.generatorsOff).has('RELATIONS')) {
            relations = (await packContext.mounts(['relations'])).get('relations')?.ok === true;
        }
        const names = packNamesFor(kinds, settings.personaKeys, { relations });
        const pinned = pinsFor(names, await packContext.mounts(names));
        if (!pinned.ok) throw new PacksNotMountableError(pinned.refusals);
        const { depth, detail, personaKeys } = settings;
        // Phase 4.4 (D23): the session's length is the author's (the request's, else four rounds); the six-round limit is gone.
        const length: SessionLength = parsed.length ?? DEFAULT_SESSION_LENGTH;
        const session = await InterviewSessionRepository.create(db, ctx.workspaceId, {
            bookId,
            scope: parsed.scope,
            targetElementId: parsed.scope === 'ELEMENT' ? parsed.elementId! : null,
            targetKind: parsed.scope === 'KIND' ? parsed.kind! : null,
            scopeElementIds: selection?.elementIds ?? [],
            scopeRelationIds: selection?.relationIds ?? [],
            slotKind: slot?.kind ?? null,
            slotAfterElementId: slot?.afterElementId ?? null,
            slotBeforeElementId: slot?.beforeElementId ?? null,
            slotAct: slot?.act ?? null,
            staleFlagId: parsed.staleFlagId ?? null,
            stressTestId: parsed.stressTestId ?? null,
            depth,
            detail,
            personaKeys,
            offerRecommended: settings.offerRecommended,
            preferChoice: settings.preferChoice,
            ...lengthColumns(length),
            generatorsOff: settings.generatorsOff,
            tokenBudget: tokenBudgetFor(length, detail, personaKeys.length),
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
                    scopeElements: session.scopeElementIds.length,
                    scopeRelations: session.scopeRelationIds.length,
                    ...(slot ? { slotAfterElementId: slot.afterElementId, slotBeforeElementId: slot.beforeElementId } : {}),
                    ...(parsed.staleFlagId ? { staleFlagId: parsed.staleFlagId } : {}),
                    ...(parsed.stressTestId ? { stressTestId: parsed.stressTestId } : {}),
                    depth,
                    detail,
                    personaKeys,
                    offerRecommended: settings.offerRecommended,
                    preferChoice: settings.preferChoice,
                    dialSources: sources,
                    length: length.mode,
                    generatorsOff: settings.generatorsOff,
                    packs: pinned.pins.map((p) => `${p.name}@${p.version}`),
                },
            },
            { db },
        );
        return { session, claim: await claimRound(db, ctx, session, generator, packContext, !contextEmbedderOf(deps)) };
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

/**
 * A subject an interview may ask about, as its page names it (Phase 2.4): no
 * stored value. Since Phase 3.3 a relation (its id, its ends and label, and its
 * type's field labels) or a BETWEEN session's element not yet created (its id
 * `PENDING_SUBJECT_ID`, between two named neighbours).
 */
export interface ScopeElementView {
    id: string;
    name: string;
    kind: BibleElementKind;
    relation?: { fromName: string; toName: string; label: string };
    pending?: { afterName: string; beforeName: string };
    /** A relation's field labels by key (its type's, not its kind's). */
    fieldLabels?: Record<string, string>;
}

/** What `interviewScopeElements` is asked about: a target as the setup names it, or a stored session's scope. */
export type ScopeQuery =
    | { scope: 'ELEMENT'; elementId: string }
    | { scope: 'KIND'; kind: BibleElementKind }
    | { scope: 'BOOK' }
    /** `frozen`: a started session's scope, exactly as the start resolved it (no relation made since is added). */
    | { scope: 'SELECTION'; elementIds: readonly string[]; relationIds: readonly string[]; frozen?: boolean }
    | { scope: 'BETWEEN'; afterElementId: string; beforeElementId: string };

/**
 * The elements a scope covers, for the interview page to name them (Phase
 * 2.4; `bible.view`): one element, one kind's, or the book's, at most
 * `SCOPE_ELEMENTS_MAX` (the engine's own bound; `truncated` beyond it). An
 * element the book does not hold is a 404.
 */
export async function interviewScopeElements(ctx: WorkspaceRequestContext, bookId: string, scope: ScopeQuery): Promise<{ elements: ScopeElementView[]; truncated: boolean }> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        if (scope.scope === 'SELECTION') {
            // The selection's elements, its relations and those between its elements (as the start resolves them; one gone since is left out).
            // A started session's scope is FROZEN: its stored relations already hold those between its elements, and a relation
            // made since is not asked about, so it is not named either.
            const elements = await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, scope.elementIds.slice(0, SCOPE_ELEMENTS_MAX));
            const between = scope.frozen ? [] : await BibleRelationRepository.listBetween(db, ctx.workspaceId, bookId, elements.map((e) => e.id), SCOPE_RELATIONS_MAX);
            const relationIds = [...new Set([...scope.relationIds, ...between.map((r) => r.id)])].slice(0, SCOPE_RELATIONS_MAX);
            const relations = await BibleRelationRepository.listByIdsWithEnds(db, ctx.workspaceId, bookId, relationIds);
            return {
                elements: [
                    ...elements.map((e) => ({ id: e.id, name: e.name, kind: e.kind })),
                    ...relations.map((r) => {
                        const label = getRelationType(r.from.kind, r.type)?.label ?? r.type;
                        return {
                            id: r.id,
                            name: relationSubjectName({ fromName: r.from.name, toName: r.to.name, label }),
                            kind: r.from.kind,
                            relation: { fromName: r.from.name, toName: r.to.name, label },
                            fieldLabels: Object.fromEntries(relationFieldDefs(r.from.kind, r.type).map((f) => [f.key, f.label])),
                        };
                    }),
                ],
                truncated: false,
            };
        }
        if (scope.scope === 'BETWEEN') {
            // The two neighbours, named, and the element not yet created between them.
            const ends = await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, [scope.afterElementId, scope.beforeElementId]);
            const after = ends.find((e) => e.id === scope.afterElementId);
            const before = ends.find((e) => e.id === scope.beforeElementId);
            if (!after || !before) throw new NotFoundError('Element not found.');
            return {
                elements: [
                    { id: after.id, name: after.name, kind: after.kind },
                    { id: before.id, name: before.name, kind: before.kind },
                    { id: PENDING_SUBJECT_ID, name: `${after.name} → … → ${before.name}`, kind: SLOT_KIND, pending: { afterName: after.name, beforeName: before.name } },
                ],
                truncated: false,
            };
        }
        if (scope.scope === 'ELEMENT') {
            const e = await requireElement(db, ctx, bookId, scope.elementId);
            return { elements: [{ id: e.id, name: e.name, kind: e.kind }], truncated: false };
        }
        const rows = await BibleElementRepository.listForInterview(db, ctx.workspaceId, bookId, { kind: scope.scope === 'KIND' ? scope.kind : undefined, take: SCOPE_ELEMENTS_MAX + 1 });
        return { elements: rows.slice(0, SCOPE_ELEMENTS_MAX).map((e) => ({ id: e.id, name: e.name, kind: e.kind })), truncated: rows.length > SCOPE_ELEMENTS_MAX };
    });
}

/**
 * Generate the session's next round (a paused session resumes). Phase 4.4 (D30): `goOn: true` is the author's choice
 * to go on past the point where every remaining question was minor (a session paused VALUE_FELL); recorded on the
 * session, which no longer pauses for it.
 */
export async function nextRound(ctx: WorkspaceRequestContext, bookId: string, sessionId: string, deps: InterviewDeps = {}, input: unknown = {}): Promise<InterviewView> {
    await assertPermission(ctx, 'bible.edit');
    const { goOn } = NextRoundInput.parse(input ?? {});
    const generator = generatorOf(ctx, deps);
    const packContext = packContextOf(deps);
    deps = { ...deps, packs: packContext.registry };
    const claimed = await runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await InterviewSessionRepository.lock(db, sessionId);
        let session = await requireSession(db, ctx, bookId, sessionId);
        assertNotEnded(session);
        if (goOn && !session.minorAccepted) {
            await InterviewSessionRepository.update(db, ctx.workspaceId, sessionId, { minorAccepted: true });
            await logEvent(ctx, { action: 'INTERVIEW_MINOR_ACCEPTED', entityType: 'InterviewSession', entityId: sessionId, details: { bookId, roundsRun: session.roundsRun } }, { db });
            session = await requireSession(db, ctx, bookId, sessionId);
        }
        return { session, claim: await claimRound(db, ctx, session, generator, packContext, !contextEmbedderOf(deps)) };
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
        // Phase 4.4 (D30, item 2): each source question answered yes or no decides its fact, as the Facts page would.
        const factDecisions = await decideFactsFromRound(db, ctx, bookId, questions, latest);
        await InterviewRoundRepository.update(db, ctx.workspaceId, round.id, { status: 'CLOSED', closedAt: new Date() });
        await InterviewSessionRepository.update(db, ctx.workspaceId, sessionId, { roundsRun: session.roundsRun + 1 });
        await logEvent(
            ctx,
            {
                action: 'INTERVIEW_ROUND_CLOSED',
                entityType: 'InterviewRound',
                entityId: round.id,
                details: { sessionId, roundNumber, questionCount: questions.length, skippedAtClose: unanswered.length, ...factDecisions },
            },
            { db },
        );

        const after = await requireSession(db, ctx, bookId, sessionId);
        const state = await loadInterviewState(db, ctx, after);
        const stop = stopNow(after, state, undefined, await planSession(db, ctx, after, state));
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
                // Phase 4.4 (D30, item 2): the open round's source questions answered yes or no decide their facts as it closes.
                const asked = (await QuestionRepository.listForRound(db, ctx.workspaceId, sessionId, r.id, SESSION_QUESTIONS_MAX)).filter((q) => q.supersededAt === null);
                await decideFactsFromRound(db, ctx, bookId, asked, latestAnswers(await AnswerRepository.listForSession(db, ctx.workspaceId, sessionId, SESSION_ANSWERS_MAX)));
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
