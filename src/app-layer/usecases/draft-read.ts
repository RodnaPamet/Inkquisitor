/**
 * ONE NIGHT'S DRAFT READING OF ONE BOOK (Phase 5.3, D35): the body of the `draft-read` job. The worker hands it
 * `{ workspaceId, runId }`; nothing else crosses Redis. The nightly dispatcher (`draft-read-dispatch.ts`) queued it
 * because a scene's text changed since it was last read (or was never read).
 *
 *   1. LOOK     the run must be QUEUED; a deleted book ends it SKIPPED. The read acts as the workspace's
 *               longest-standing OWNER (else EDITOR): none ends it SKIPPED NO_ACTOR, nothing sent.
 *   2. CLAIM    QUEUED → RUNNING. Read the scenes due (least recently read first, at most `DRAFT_SCENES_PER_NIGHT`),
 *               the book's live bible facts (bounded), its story order (D25, the clock), its element names and its
 *               open threads.
 *   3. EACH SCENE, from its CURRENT text (3.4's reader, `sceneProseText`; the text's keyed hash `textKey`):
 *        empty        its draft facts are superseded and its open mismatches settled FIXED (the draft says nothing)
 *        unchanged    (a details-only save: its POV, its story time, its beats) — no call: its live draft facts are
 *                     compared again with the bible at the scene's new place in story time
 *        changed      cut into pieces (`planDraftCalls`: bounded text, the cut named; each piece's worst case inside the
 *                     ENFORCED per-call budget, halved, else CALL_OVER_BUDGET — passed over until the text changes); then
 *                     the night's SHARE (D35 item 2: draft reading and the continuity check together, measured from the
 *                     ledger by both purposes, checked here with the scene's worst case and again by the ledger under
 *                     its spend lock as each call reserves), the kill switch, D11 and the model-call minute (waited,
 *                     never an uncharged call); one fast call a piece (`DRAFT_READ_PROMPT`); each answer validated on
 *                     the piece it was shown (4.0's fact rules; the thread links' own)
 *      and PERSISTED in one transaction under the book's fact lock (`story-facts:<bookId>`, taken alone), only while
 *      the scene's text still keys as the text read (a save meanwhile discards the read: the scene stays due):
 *        draft facts  a claim already held at the same text is kept (re-reading the same text writes nothing); every
 *                     other live draft fact of the scene is superseded, the new ones written (never canon: PENDING,
 *                     never decided, never embedded), and superseded ones no mismatch stands on deleted
 *        mismatches   each live draft fact compared with the bible facts (`compareDraftWithBible`, 4.2's rules); a new
 *                     pair is RAISED (one open mismatch a bible fact, scene and claim, the partial unique index);
 *                     an open one whose pair the draft no longer makes is SETTLED FIXED (whether or not the author
 *                     chose "fix the draft myself"); nothing writes the bible or the scene (rule 1, D3)
 *        links        each thread link PROPOSED once a thread, scene and role, ever (decided by the author)
 *        cursor       the scene's `SceneDraftRead` (its revision and text key: not read again until it changes)
 *   4. FINISH   every scene due read: OK; scenes left: DONE PAGED (the next night goes on). A stop (the ceiling, the
 *               night's share, the kill switch, D11, the rate minute, an outage, an abort) is resumable and never
 *               FAILED. Audit last.
 *
 * D3: NOTHING HERE WRITES A SCENE'S TEXT. The scene's text is read and sent as fenced data; the model's answer becomes
 * draft facts, mismatches and link proposals, never prose (`tests/guards/scene-text-stays-off-the-model-path.test.ts`).
 * PRIVACY: nothing logged, counted or carried in a payload holds a scene's words (ids, counts and codes only).
 */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { BibleElementRepository } from '@/app-layer/repositories/bible.repository';
import { BookRepository } from '@/app-layer/repositories/book.repository';
import { placedElementsOf, StoryThreadRepository } from '@/app-layer/repositories/continuity.repository';
import {
    DraftFactRepository,
    DraftMismatchRepository,
    DraftReadRunRepository,
    SceneDraftReadRepository,
    ThreadSceneLinkRepository,
    type DraftFactInsert,
    type DraftFactRow,
    type DraftRunCounts,
    type DueScene,
} from '@/app-layer/repositories/draft-facts.repository';
import { BibleFactRepository, StoryFactRepository } from '@/app-layer/repositories/source.repository';
import type { AuthorDataBlock } from '@/lib/ai/prompt';
import { monthlyCeilingMicroUsd } from '@/lib/ai/config';
import { NIGHT_SHARE_PURPOSES } from '@/lib/continuity/night-share';
import { NO_ORDER, storyClock, type StoryClock } from '@/lib/continuity/story-clock';
import { CLOCK_ELEMENTS_MAX, CONTINUITY_NIGHT_WINDOW_MS, CONTINUITY_NIGHTLY_SHARE } from '@/lib/continuity/vocabulary';
import { compareDraftWithBible, sceneBeat, type CompareFact } from '@/lib/draft-facts/compare';
import { draftReadCallWorstCase } from '@/lib/draft-facts/cost';
import { draftClaimKey, draftTextKey } from '@/lib/draft-facts/keys';
import { defaultDraftReader, DRAFT_NIGHTLY_SHARE_REFUSED, type DraftReader } from '@/lib/draft-facts/model-seam';
import { planDraftCalls } from '@/lib/draft-facts/pieces';
import { DRAFT_READ_CALL_COST_BUDGET_MICRO_USD, DRAFT_READ_PROMPT_VERSION } from '@/lib/draft-facts/prompt';
import { draftReadGate, type DraftReadGateVerdict } from '@/lib/draft-facts/record-gate';
import { sanitiseLinkQuoteForStorage } from '@/lib/draft-facts/storage';
import { validateDraftRead } from '@/lib/draft-facts/validate';
import {
    DRAFT_BIBLE_FACTS_READ_MAX,
    DRAFT_CALLS_PER_NIGHT,
    DRAFT_MISMATCHES_PER_RUN_MAX,
    DRAFT_PIECE_MAX_CHARS,
    DRAFT_PIECE_MIN_CHARS,
    DRAFT_SCENE_FAILURES_MAX,
    DRAFT_SCENES_PER_NIGHT,
    DRAFT_TEXT_MAX_CHARS,
    DRAFT_THREADS_SHOWN_MAX,
    type DraftReadOutcome,
    type DraftReadRunStatus,
} from '@/lib/draft-facts/vocabulary';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { nameKey } from '@/lib/enrichment/validate';
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import { logger } from '@/lib/observability/logger';
import { sceneProseText } from '@/lib/prose-checks/scene-text';
import { chargeModelCalls } from '@/lib/security/model-call-rate-limit';
import { sanitiseFactForStorage } from '@/lib/sources/storage';
import type { FactDraft } from '@/lib/sources/validate';
import { env } from '@/env';
import { defaultSleep, waitForModelRate } from './bible-facts';
import { actorFor } from './continuity-check';
import { deploymentPackRecordMode } from './interview-packs';
import { modelUnavailableReason, nightlyShareSpent, type NightlyShare } from './model-calls';

export interface DraftReadDeps {
    reader?: (ctx: WorkspaceRequestContext, share: NightlyShare) => DraftReader;
    recordMode?: PackRecordMode;
    gate?: () => DraftReadGateVerdict;
    signal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    charge?: (workspaceId: string, calls: number) => void;
    now?: () => Date;
    /** A call's worst case in µUSD over its data blocks (tests: a figure of their own). */
    worstCase?: (blocks: readonly AuthorDataBlock[]) => number;
    /** The night's bounds (tests: smaller ones). */
    callsPerNight?: number;
    scenesPerNight?: number;
    /** The night's share in µUSD (tests: a figure of their own; default `CONTINUITY_NIGHTLY_SHARE` of the month's ceiling). */
    nightlyCapMicroUsd?: number;
    pieceMaxChars?: number;
}

/** The state after a run: resumable stops keep every scene read so far. */
const STATUS_OF: Readonly<Record<DraftReadOutcome, DraftReadRunStatus>> = {
    OK: 'DONE',
    PAGED: 'DONE',
    NOTHING_TO_READ: 'DONE',
    BOOK_DELETED: 'SKIPPED',
    NO_ACTOR: 'SKIPPED',
    CEILING: 'STOPPED',
    NIGHTLY_CAP: 'STOPPED',
    KILL_SWITCH: 'STOPPED',
    AI_UNAVAILABLE: 'STOPPED',
    NOT_EVALUATED: 'STOPPED',
    MODEL_RATE_LIMITED: 'STOPPED',
    CALL_FAILED: 'STOPPED',
    ABORTED: 'STOPPED',
    CLAIM_EXPIRED: 'STOPPED',
    INTERNAL: 'FAILED',
};

/** A call's failures the TEXT causes, so it fails the same way every night: counted on the scene, passed over after `DRAFT_SCENE_FAILURES_MAX`. */
const TEXT_OWN_FAILURES: ReadonlySet<string> = new Set(['INVALID_OUTPUT', 'PROMPT_INVALID']);
/** Failures that mean nothing reached the provider unless the call reports tokens or cost. */
const REFUSED_BEFORE_SEND: ReadonlySet<string> = new Set(['KILL_SWITCH', 'WORKSPACE_CEILING', 'AI_UNAVAILABLE', 'PROMPT_INVALID', 'GUARD_REFUSED', 'ABORTED']);

interface Metrics {
    refusals: Record<string, number>;
    callIds: string[];
    bibleFactsCut: boolean;
    clockKnown: boolean;
    pairsCompared: number;
    scenesDiscarded: number;
    scenesPassedOver: number;
    scenesTextCut: number;
    errorCode?: string;
}

interface BibleSide extends CompareFact {
    ownerElementId: string | null;
}

/** What a scene's read produced, before it is persisted. */
interface SceneReadResult {
    facts: FactDraft[];
    links: Array<{ threadId: string; role: string; quote: string; quoteStart: number; quoteEnd: number; flags: string[] }>;
    guardRefusedAll: boolean;
    textCut: boolean;
    costMicroUsd: number;
}

/** Run one night's draft reading of one book (the job's body). */
export async function executeDraftRead(payload: { workspaceId: string; runId: string }, deps: DraftReadDeps = {}): Promise<{ ran: boolean; outcome: DraftReadOutcome | null }> {
    const now = deps.now ?? (() => new Date());
    const scope = { workspaceId: payload.workspaceId, requestId: randomUUID() };
    const counts: DraftRunCounts = { scenesRead: 0, scenesRemaining: 0, factsKept: 0, mismatchesRaised: 0, mismatchesFixed: 0, linksProposed: 0, callsMade: 0 };
    const metrics: Metrics = { refusals: {}, callIds: [], bibleFactsCut: false, clockKnown: false, pairsCompared: 0, scenesDiscarded: 0, scenesPassedOver: 0, scenesTextCut: 0 };
    let cost = 0;

    // 1. LOOK
    const looked = await runInWorkspaceContext(scope, async (db) => {
        const run = await DraftReadRunRepository.find(db, payload.workspaceId, payload.runId);
        if (!run || run.status !== 'QUEUED') return null;
        if (!(await BookRepository.find(db, payload.workspaceId, run.bookId))) return { run, ctx: null, skip: 'BOOK_DELETED' as const };
        const ctx = await actorFor(db, payload.workspaceId, scope.requestId);
        return { run, ctx, skip: ctx ? null : ('NO_ACTOR' as const) };
    });
    if (!looked) return { ran: false, outcome: null };
    const { run } = looked;
    const finish = async (outcome: DraftReadOutcome, claimed: boolean) => {
        const at = now();
        await runInWorkspaceContext(looked.ctx ?? scope, async (db) => {
            const done = await DraftReadRunRepository.finish(db, payload.workspaceId, run.id, {
                status: STATUS_OF[outcome],
                outcome,
                from: claimed ? ['RUNNING'] : ['QUEUED'],
                counts,
                costMicroUsd: cost,
                promptVersion: counts.callsMade > 0 ? DRAFT_READ_PROMPT_VERSION : null,
                metrics: metrics as unknown as Prisma.InputJsonValue,
                at,
            });
            // AUDIT LAST (3.H).
            if (done && looked.ctx) {
                await logEvent(looked.ctx, { action: 'DRAFT_READ', entityType: 'DraftReadRun', entityId: run.id, details: { bookId: run.bookId, outcome, ...counts } }, { db, actorType: 'SYSTEM' });
            }
        });
        // Ids, counts and codes only: never a scene's text or a fact's.
        logger.info('draft read finished', { component: 'draft-facts', runId: run.id, bookId: run.bookId, outcome, ...counts, costMicroUsd: cost });
        return { ran: true, outcome };
    };
    if (looked.skip || !looked.ctx) return finish(looked.skip ?? 'NO_ACTOR', false);
    const ctx = looked.ctx;
    const bookId = run.bookId;

    // 2. CLAIM
    const scenesPerNight = deps.scenesPerNight ?? DRAFT_SCENES_PER_NIGHT;
    const claimed = await runInWorkspaceContext(ctx, async (db) => {
        const at = now();
        if (!(await DraftReadRunRepository.claim(db, ctx.workspaceId, run.id, at))) return null;
        const due = await SceneDraftReadRepository.dueScenes(db, ctx.workspaceId, bookId, scenesPerNight + 1);
        const bible = await BibleFactRepository.listLiveForBook(db, ctx.workspaceId, bookId, DRAFT_BIBLE_FACTS_READ_MAX + 1);
        const placed = await placedElementsOf(db, ctx.workspaceId, bookId, CLOCK_ELEMENTS_MAX + 1);
        const names = await BibleElementRepository.listForInterview(db, ctx.workspaceId, bookId, { take: 200 });
        const threads = await StoryThreadRepository.listOpen(db, ctx.workspaceId, bookId, DRAFT_THREADS_SHOWN_MAX);
        return { claim: at, due, bible, placed, names, threads };
    });
    if (!claimed) return { ran: false, outcome: null };
    const { claim } = claimed;
    const due = claimed.due.slice(0, scenesPerNight);
    counts.scenesRemaining = claimed.due.length;
    if (due.length === 0) return finish('NOTHING_TO_READ', true);

    metrics.bibleFactsCut = claimed.bible.length > DRAFT_BIBLE_FACTS_READ_MAX;
    const bible: BibleSide[] = claimed.bible.slice(0, DRAFT_BIBLE_FACTS_READ_MAX).map((f) => ({
        id: f.id,
        predicate: f.predicate,
        subjectElementId: f.subjectElementId,
        objectLiteral: f.objectLiteral,
        statement: f.statement,
        storyTimeFrom: f.storyTimeFrom,
        storyTimeTo: f.storyTimeTo,
        ownerElementId: f.sourceKind === 'BIBLE_VERSION' ? f.elementId : null,
    }));
    const bibleRead = new Set(bible.map((b) => b.id));
    metrics.clockKnown = claimed.placed.length <= CLOCK_ELEMENTS_MAX;
    const clock: StoryClock = metrics.clockKnown ? storyClock(claimed.placed.map((e) => ({ id: e.id, kind: e.kind, name: e.name, orderRank: e.orderRank! }))) : NO_ORDER;
    const byNameKey = new Map<string, string | null>();
    for (const n of claimed.names) {
        const key = nameKey(n.name);
        byNameKey.set(key, byNameKey.has(key) ? null : n.id);
    }
    const linkOf = (name: string | null): string | null => (name ? (byNameKey.get(nameKey(name)) ?? null) : null);
    const bookNames = claimed.names.map((n) => n.name);
    const threadsShown = claimed.threads.map((t) => ({ id: t.id, kind: t.kind, title: t.title }));

    const share: NightlyShare = {
        purpose: NIGHT_SHARE_PURPOSES,
        since: new Date(claim.getTime() - CONTINUITY_NIGHT_WINDOW_MS),
        capMicroUsd: deps.nightlyCapMicroUsd ?? Math.floor(CONTINUITY_NIGHTLY_SHARE * monthlyCeilingMicroUsd(env)),
    };
    const reader = (deps.reader ?? ((c: WorkspaceRequestContext, s: NightlyShare) => defaultDraftReader(c, {}, s)))(ctx, share);
    const worst = deps.worstCase ?? ((blocks: readonly AuthorDataBlock[]) => draftReadCallWorstCase(blocks));
    const callsPerNight = deps.callsPerNight ?? DRAFT_CALLS_PER_NIGHT;
    let gatesAsked = false;
    const saveProgress = () => runInWorkspaceContext(ctx, (db) => DraftReadRunRepository.progress(db, ctx.workspaceId, run.id, counts, cost));

    /** Persist a scene's read (or its empty text, or its re-compare): the draft facts, mismatches, links and cursor. */
    const persist = async (dueScene: DueScene, read: { textKey: string; revision: number; storyTime: string | null; beatIds: readonly string[]; result: SceneReadResult | null; empty: boolean; outcome: 'OK' | 'EMPTY' | 'GUARD_REFUSED' }): Promise<boolean> => {
        return runInWorkspaceContext(ctx, async (db) => {
            await BibleFactRepository.lockBook(db, bookId);
            // The text read must still be the scene's: a save meanwhile discards the read (the scene stays due).
            const current = await SceneDraftReadRepository.sceneForRead(db, ctx.workspaceId, bookId, dueScene.sceneId);
            if (!current || draftTextKey(ctx.workspaceId, current.text) !== read.textKey) return false;
            const at = now();
            if (read.outcome === 'GUARD_REFUSED') {
                // Every piece tripped the guard: nothing was read, so nothing the scene said before is retracted or settled.
                await SceneDraftReadRepository.upsert(db, ctx.workspaceId, bookId, dueScene.sceneId, { revision: read.revision, textKey: read.textKey, outcome: 'GUARD_REFUSED', textCut: read.result?.textCut ?? false, failures: 0, factsKept: 0, costMicroUsd: read.result?.costMicroUsd ?? 0, at });
                return true;
            }
            const live = await DraftFactRepository.liveForScene(db, ctx.workspaceId, bookId, dueScene.sceneId);
            let liveAfter: DraftFactRow[] | Array<Pick<DraftFactRow, 'id' | 'dedupeKey' | 'predicate' | 'subjectElementId' | 'objectLiteral' | 'statement' | 'storyTimeFrom' | 'storyTimeTo'>> = live;
            let kept = 0;
            if (read.empty) {
                await StoryFactRepository.supersedeDraftFacts(db, ctx.workspaceId, live.map((f) => f.id), at);
                liveAfter = [];
            } else if (read.result) {
                // The new facts, sanitised, linked, keyed; one a claim (the first wins).
                const rows: DraftFactInsert[] = [];
                const keys = new Set<string>();
                for (const draft of read.result.facts) {
                    let clean: FactDraft;
                    try {
                        clean = sanitiseFactForStorage(draft);
                    } catch {
                        metrics.refusals.NOT_STORABLE = (metrics.refusals.NOT_STORABLE ?? 0) + 1;
                        continue;
                    }
                    const subjectElementId = linkOf(clean.subjectName);
                    const key = draftClaimKey(ctx.workspaceId, dueScene.sceneId, { predicate: clean.predicate, subjectElementId, objectLiteral: clean.objectLiteral, statement: clean.statement });
                    if (keys.has(key)) continue;
                    keys.add(key);
                    rows.push({
                        bookId,
                        sceneId: dueScene.sceneId,
                        sceneTextKey: read.textKey,
                        dedupeKey: key,
                        position: rows.length,
                        subjectName: clean.subjectName,
                        subjectElementId,
                        predicate: clean.predicate,
                        objectElementId: linkOf(clean.objectLiteral),
                        objectLiteral: clean.objectLiteral,
                        statement: clean.statement,
                        quote: clean.quote,
                        quoteStart: clean.quoteStart,
                        quoteEnd: clean.quoteEnd,
                        storyTimeFrom: clean.storyTimeFrom,
                        storyTimeTo: clean.storyTimeTo,
                        flags: clean.flags,
                    });
                }
                // Re-reading the same text writes nothing (4.H item 1): a claim already held at this text is kept.
                const heldHere = new Map(live.filter((f) => f.sceneTextKey === read.textKey && f.dedupeKey).map((f) => [f.dedupeKey!, f] as const));
                const fresh = rows.filter((r) => !heldHere.has(r.dedupeKey));
                const keep = new Set(rows.filter((r) => heldHere.has(r.dedupeKey)).map((r) => heldHere.get(r.dedupeKey)!.id));
                await StoryFactRepository.supersedeDraftFacts(db, ctx.workspaceId, live.filter((f) => !keep.has(f.id)).map((f) => f.id), at);
                const inserted = await StoryFactRepository.createDraftFacts(db, ctx.workspaceId, fresh);
                kept = rows.length;
                const byId = new Map(fresh.map((r, i) => [inserted[i].id, r] as const));
                liveAfter = [
                    ...live.filter((f) => keep.has(f.id)),
                    ...[...byId].map(([id, r]) => ({ id, dedupeKey: r.dedupeKey, predicate: r.predicate, subjectElementId: r.subjectElementId, objectLiteral: r.objectLiteral, statement: r.statement, storyTimeFrom: r.storyTimeFrom, storyTimeTo: r.storyTimeTo })),
                ];
            }
            // Mismatches: the live draft facts against the bible's, at the scene's place in story time.
            const time = { beatElementId: sceneBeat(read.beatIds, clock), storyTime: read.storyTime };
            const compared = compareDraftWithBible(liveAfter, bible, time, clock);
            metrics.pairsCompared += compared.compared;
            const keyOf = new Map(liveAfter.map((f) => [f.id, f.dedupeKey ?? ''] as const));
            const standing = new Set(compared.pairs.map((p) => `${p.bibleFactId}|${keyOf.get(p.draftFactId)}`));
            const open = await DraftMismatchRepository.forScene(db, ctx.workspaceId, bookId, dueScene.sceneId, ['PENDING', 'FIX_PENDING'], DRAFT_MISMATCHES_PER_RUN_MAX * 2);
            // An open mismatch the draft no longer makes is settled FIXED — judged only against a bible fact this run read.
            const gone = open.filter((m) => bibleRead.has(m.factId) && !standing.has(`${m.factId}|${m.draftClaimKey}`)).map((m) => m.id);
            counts.mismatchesFixed += await DraftMismatchRepository.settleFixed(db, ctx.workspaceId, gone, at);
            const room = Math.max(0, DRAFT_MISMATCHES_PER_RUN_MAX - counts.mismatchesRaised);
            const toRaise = compared.pairs.slice(0, room).map((p) => ({ bookId, sceneId: dueScene.sceneId, factId: p.bibleFactId, newerFactId: p.draftFactId, kind: p.kind, draftClaimKey: keyOf.get(p.draftFactId)!, draftRunId: run.id }));
            if (compared.pairs.length > room) metrics.refusals.MISMATCH_DEFERRED = (metrics.refusals.MISMATCH_DEFERRED ?? 0) + compared.pairs.length - room;
            counts.mismatchesRaised += await DraftMismatchRepository.raise(db, ctx.workspaceId, toRaise);
            // Links: proposed once a thread, scene and role, ever.
            if (read.result) {
                const rows = [];
                for (const l of read.result.links) {
                    try {
                        rows.push({ bookId, threadId: l.threadId, sceneId: dueScene.sceneId, role: l.role, quote: sanitiseLinkQuoteForStorage(l.quote), quoteStart: l.quoteStart, quoteEnd: l.quoteEnd, sceneTextKey: read.textKey, flags: l.flags, runId: run.id });
                    } catch {
                        metrics.refusals.NOT_STORABLE = (metrics.refusals.NOT_STORABLE ?? 0) + 1;
                    }
                }
                counts.linksProposed += await ThreadSceneLinkRepository.propose(db, ctx.workspaceId, rows);
            }
            await StoryFactRepository.deleteUnanchoredDraftFacts(db, ctx.workspaceId, bookId, dueScene.sceneId);
            await SceneDraftReadRepository.upsert(db, ctx.workspaceId, bookId, dueScene.sceneId, {
                revision: read.revision,
                textKey: read.textKey,
                outcome: read.outcome,
                textCut: read.result?.textCut ?? false,
                failures: 0,
                factsKept: read.empty ? 0 : read.result ? kept : liveAfter.length,
                costMicroUsd: read.result?.costMicroUsd ?? 0,
                at,
            });
            counts.factsKept += kept;
            return true;
        });
    };

    try {
        let processed = 0;
        for (const dueScene of due) {
            if (deps.signal?.aborted) return await finish('ABORTED', true);
            const scene = await runInWorkspaceContext(ctx, (db) => SceneDraftReadRepository.sceneForRead(db, ctx.workspaceId, bookId, dueScene.sceneId));
            if (!scene) {
                processed++;
                continue;
            }
            const textKey = draftTextKey(ctx.workspaceId, scene.text);
            const plain = sceneProseText(scene.text).text;
            const beatIds = scene.beatLinks.map((b) => b.beatElementId);
            const base = { textKey, revision: scene.revision, storyTime: scene.storyTime, beatIds };

            if (plain.trim() === '') {
                if (await persist(dueScene, { ...base, result: null, empty: true, outcome: 'EMPTY' })) counts.scenesRead++;
                else metrics.scenesDiscarded++;
                processed++;
                continue;
            }
            if (textKey === dueScene.readTextKey) {
                // A details-only save: no call, the scene's facts compared again at its new place.
                if (await persist(dueScene, { ...base, result: null, empty: false, outcome: 'OK' })) counts.scenesRead++;
                else metrics.scenesDiscarded++;
                processed++;
                continue;
            }

            const headings = [scene.chapter.title, scene.title].filter((t): t is string => !!t && t.trim() !== '');
            const plan = planDraftCalls({
                text: plain,
                textMax: DRAFT_TEXT_MAX_CHARS,
                headings,
                bookNames,
                threads: threadsShown,
                budgetMicroUsd: DRAFT_READ_CALL_COST_BUDGET_MICRO_USD,
                maxChars: deps.pieceMaxChars ?? DRAFT_PIECE_MAX_CHARS,
                minChars: Math.min(DRAFT_PIECE_MIN_CHARS, deps.pieceMaxChars ?? DRAFT_PIECE_MAX_CHARS),
                worst,
            });
            if (!plan.ok) {
                // Over the per-call budget even at its smallest: passed over (named) until its text changes; nothing sent.
                metrics.scenesPassedOver++;
                await runInWorkspaceContext(ctx, (db) =>
                    SceneDraftReadRepository.upsert(db, ctx.workspaceId, bookId, dueScene.sceneId, { revision: scene.revision, textKey, outcome: 'CALL_OVER_BUDGET', textCut: plan.cut, failures: 0, factsKept: 0, costMicroUsd: 0, at: now() }),
                );
                processed++;
                continue;
            }
            if (counts.callsMade + plan.calls.length > callsPerNight) break;
            if (!gatesAsked) {
                const unavailable = modelUnavailableReason();
                if (unavailable) {
                    metrics.errorCode = unavailable;
                    return await finish(unavailable === 'AI_DISABLED' ? 'KILL_SWITCH' : 'AI_UNAVAILABLE', true);
                }
                const verdict = (deps.gate ?? (() => draftReadGate(deps.recordMode ?? deploymentPackRecordMode())))();
                if (!verdict.mounted) {
                    metrics.errorCode = verdict.reason;
                    return await finish('NOT_EVALUATED', true);
                }
                gatesAsked = true;
            }
            const sceneWorst = plan.calls.reduce((n, c) => n + c.worstMicroUsd, 0);
            const spent = await runInWorkspaceContext(ctx, (db) => nightlyShareSpent(db, ctx, share));
            if (spent + sceneWorst > share.capMicroUsd) return await finish('NIGHTLY_CAP', true);

            const result: SceneReadResult = { facts: [], links: [], guardRefusedAll: true, textCut: plan.cut, costMicroUsd: 0 };
            let sceneFailed: string | null = null;
            for (const call of plan.calls) {
                if (deps.signal?.aborted) return await finish('ABORTED', true);
                if (!(await waitForModelRate(ctx, deps.charge ?? chargeModelCalls, deps.sleep ?? defaultSleep, deps.signal))) {
                    return await finish(deps.signal?.aborted ? 'ABORTED' : 'MODEL_RATE_LIMITED', true);
                }
                const r = await reader.extract({ data: call.blocks, bookId }, deps.signal);
                if (r.ok || !REFUSED_BEFORE_SEND.has(r.failure) || r.tokensUsed > 0 || r.costMicroUsd > 0) counts.callsMade++;
                if (metrics.callIds.length < 50) metrics.callIds.push(...r.callIds);
                cost += r.costMicroUsd;
                result.costMicroUsd += r.costMicroUsd;
                if (!r.ok) {
                    metrics.errorCode = r.errorCode;
                    if (r.failure === 'KILL_SWITCH') return await finish('KILL_SWITCH', true);
                    if (r.failure === 'WORKSPACE_CEILING') return await finish(r.errorCode === DRAFT_NIGHTLY_SHARE_REFUSED ? 'NIGHTLY_CAP' : 'CEILING', true);
                    if (r.failure === 'AI_UNAVAILABLE') return await finish('AI_UNAVAILABLE', true);
                    if (r.failure === 'ABORTED') return await finish('ABORTED', true);
                    // The guard refused this piece (or it repeats the prompt): it yields nothing, the scene goes on.
                    if (r.failure === 'GUARD_REFUSED' || (r.failure === 'PROMPT_INVALID' && r.errorCode === 'REPEATS_PROMPT')) {
                        metrics.refusals[r.failure] = (metrics.refusals[r.failure] ?? 0) + 1;
                        continue;
                    }
                    if (TEXT_OWN_FAILURES.has(r.failure)) {
                        sceneFailed = r.failure;
                        break;
                    }
                    // An outage or a timeout: the night stops, resumable; the scene is read again.
                    return await finish('CALL_FAILED', true);
                }
                result.guardRefusedAll = false;
                const v = validateDraftRead(r.output, { text: call.piece.text, headingPath: headings, offset: call.piece.offset }, call.threadsShown);
                for (const [code, n] of Object.entries({ ...v.factRefusals, ...Object.fromEntries(Object.entries(v.linkRefusals).map(([k, x]) => [`LINK_${k}`, x])) })) metrics.refusals[code] = (metrics.refusals[code] ?? 0) + (n ?? 0);
                result.facts.push(...v.facts);
                for (const l of v.links) {
                    const thread = threadsShown[l.threadIndex];
                    if (thread) result.links.push({ threadId: thread.id, role: l.role, quote: l.quote, quoteStart: l.quoteStart, quoteEnd: l.quoteEnd, flags: l.flags });
                }
            }
            await saveProgress();
            if (sceneFailed) {
                // An answer that is never valid fails the same text every night: counted, passed over after the bound.
                const failures = await runInWorkspaceContext(ctx, (db) => SceneDraftReadRepository.countFailure(db, ctx.workspaceId, bookId, dueScene.sceneId, textKey, now()));
                if (failures >= DRAFT_SCENE_FAILURES_MAX) {
                    metrics.scenesPassedOver++;
                    await runInWorkspaceContext(ctx, (db) =>
                        SceneDraftReadRepository.upsert(db, ctx.workspaceId, bookId, dueScene.sceneId, { revision: scene.revision, textKey, outcome: 'PASSED_OVER', textCut: plan.cut, failures, factsKept: 0, costMicroUsd: result.costMicroUsd, at: now() }),
                    );
                }
                processed++;
                continue;
            }
            if (plan.cut) metrics.scenesTextCut++;
            const ok = await persist(dueScene, { ...base, result, empty: false, outcome: result.guardRefusedAll ? 'GUARD_REFUSED' : 'OK' });
            if (ok) counts.scenesRead++;
            else metrics.scenesDiscarded++;
            processed++;
            counts.scenesRemaining = Math.max(0, claimed.due.length - processed);
            await saveProgress();
        }
        counts.scenesRemaining = Math.max(0, claimed.due.length - processed);
        return await finish(counts.scenesRemaining > 0 ? 'PAGED' : 'OK', true);
    } catch (err) {
        logger.error('draft.read_failed', { component: 'draft-facts', runId: run.id, error: err instanceof Error ? err.name : 'unknown' });
        metrics.errorCode = 'INTERNAL';
        return finish('INTERNAL', true);
    }
}
