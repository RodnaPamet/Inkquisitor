/**
 * ONE BIBLE FACT EXTRACTION (Phase 4.1, D27): the body of the `bible-facts` job.
 * The worker hands it `{ workspaceId, extractionId }`; nothing else crosses Redis.
 *
 * The extraction row was written IN THE VERSION'S TRANSACTION (the outbox
 * trigger), so a version rolled back has none and is never extracted. The
 * minutely dispatcher queues due rows (`fact-layer-dispatch.ts`). Here:
 *
 *   1. LOOK     the row must be QUEUED. A book deleted, an element or relation
 *               gone, a newer version of it (whose own extraction covers this
 *               one: a run of autosaves is extracted once) or an author who may
 *               no longer edit the bible ends it SKIPPED, nothing sent. A
 *               deployment that can make no call, or holds no evaluation record
 *               it accepts (D11), stops it STOPPED, dispatched again later.
 *   2. CLAIM    QUEUED → RUNNING (`startedAt` is the claim). Render the version
 *               (`entry-text.ts`), its BASELINE (the entry's newest extracted
 *               version) and the sections that changed between them; read the
 *               live facts about its subject(s).
 *   3. CALL     unless nothing changed: the workspace's model-call minute
 *               (`chargeModelCalls`, waited out at most `MODEL_RATE_WAIT_MAX_MS`,
 *               never an uncharged call), then ONE fast-tier call over the header
 *               and the changed sections, outside every transaction. 2.1 checks
 *               the monthly ceiling and the kill switch first: CEILING and
 *               KILL_SWITCH stop the run cleanly, resumable. Its cost is counted
 *               on the row in a transaction of its own, whatever happens next.
 *               A piece the guard refuses (or that repeats the prompt) yields
 *               nothing and the run goes on with the others (4.H-a, #60 item 2):
 *               the version still becomes the entry's baseline, so the refused
 *               text is not re-sent with every later version.
 *   4. PERSIST  under the book's fact lock: validate (4.0's rules plus the
 *               entry's own), key each claim, resolve against the live facts
 *               (`dedupe.ts`), write the new facts CONFIRMED and automatic, the
 *               provenance of each restated one, and a PROPOSAL for each
 *               contradiction and each earlier fact the entry no longer states —
 *               nothing is invalidated (rule 1); then the row DONE; audit last.
 *               Phase 4.2 (D28): the same call's THREADS (a promise, a clue, an
 *               open question set up, or an open thread paid off) are checked
 *               (`validateBibleThreads`) and PROPOSED, one per claim in the book
 *               ever, citing the version and its words; contradictions carry
 *               their KIND, and rules read the story order (D25) as a fact's time.
 *
 * 4.H-b (D32): the baseline's record of what the guard refused
 * (`guardRefused`, each section with the rule version that refused it) is
 * carried forward while a section is unchanged, and a section refused under
 * OLDER rules than `GUARD_RULES_VERSION` is sent again ONCE, in calls of its own
 * (`guard-retry.ts`). A BACKFILL row (an entry saved before 4.1, D31) runs as
 * its version's author or, when they may no longer edit, the workspace's
 * longest-standing OWNER (else EDITOR); its calls are recorded under
 * `facts.bible-extract.backfill` and held to the workspace's daily share (10 % of
 * the month's ceiling, D32), checked before each call and by the ledger under
 * its spend lock: past it the row stops DAILY_SHARE, resumable, no attempt counted.
 *
 * IDEMPOTENT: a DONE or SKIPPED row is never claimed again, and a resolve run
 * twice over one version writes nothing new (the claim keys, the provenance's
 * and the proposals' unique keys). It never touches the bible or the version.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { AuthorDataBlock } from '@/lib/ai/prompt';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { BibleElementRepository, BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
import { BookRepository } from '@/app-layer/repositories/book.repository';
import { BibleVersionReadRepository, FactExtractionRepository, FactProposalRepository, FactProvenanceRepository, type FactExtractionRow } from '@/app-layer/repositories/fact-layer.repository';
import { MembershipRepository } from '@/app-layer/repositories/membership.repository';
import { BibleFactRepository, StoryFactRepository, type BibleFactInsert, type BibleFactRow, type StoryFactRow } from '@/app-layer/repositories/source.repository';
import { WorkspaceRepository } from '@/app-layer/repositories/workspace.repository';
import type { BibleKind } from '@/lib/bible/kinds';
import { parseRelationSnapshot } from '@/lib/bible/relation-snapshot';
import { parseSnapshot } from '@/lib/bible/snapshot';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { nameKey } from '@/lib/enrichment/validate';
import { RateLimitedError } from '@/lib/errors/types';
import { claimKey } from '@/lib/facts/claim-key';
import { claimParts, resolveFacts, type FactOwner, type LiveFact, type NewFact } from '@/lib/facts/dedupe';
import { changedSections, entryText, renderElementEntry, renderRelationEntry, type EntrySection, type RenderedEntry } from '@/lib/facts/entry-text';
import { planBibleFactCalls } from '@/lib/facts/call-plan';
import { guardRetryPlan, refusalsToRecord } from '@/lib/facts/guard-retry';
import { GUARD_RULES_VERSION } from '@/lib/ai/guard';
import { bibleFactsCallWorstCase } from '@/lib/facts/cost';
import { BIBLE_FACTS_BACKFILL_PURPOSE, DAILY_SHARE_REFUSED, defaultBibleFactExtractor, MONTHLY_SHARE_REFUSED } from '@/lib/facts/model-seam';
import { BIBLE_FACTS_CALL_COST_BUDGET_MICRO_USD, BIBLE_FACTS_PROMPT_VERSION, EXISTING_FACTS_SHOWN_MAX } from '@/lib/facts/prompt';
import { bibleFactGate, type BibleFactGateVerdict } from '@/lib/facts/record-gate';
import { validateBibleFacts, validateBibleThreads, type BibleFactDraft } from '@/lib/facts/validate';
import { contentTokens } from '@/lib/interview/text';
import { placedElementsOf, StoryThreadRepository, StoryThreadProposalRepository, type ThreadProposalInsert } from '@/app-layer/repositories/continuity.repository';
import { NO_ORDER, storyClock, type StoryClock } from '@/lib/continuity/story-clock';
import { sanitiseThreadProposalForStorage } from '@/lib/continuity/storage';
import { OPEN_THREADS_SHOWN_MAX } from '@/lib/continuity/vocabulary';
import { CLOCK_ELEMENTS_MAX } from '@/lib/continuity/vocabulary';
import {
    BACKFILL_DAILY_SHARE,
    BACKFILL_DAY_WINDOW_MS,
    BACKFILL_MONTHLY_SHARE,
    BIBLE_FACT_PIECE_MAX_CHARS,
    BIBLE_FACT_PIECE_MIN_CHARS,
    FACT_EXTRACTION_ATTEMPTS_MAX,
    FACT_EXTRACTION_RETRY_MS,
    readGuardRefused,
    RESUMABLE_EXTRACTION_OUTCOMES,
    type FactExtractionOutcome,
    type FactExtractionStatus,
    type GuardRefusedSection,
} from '@/lib/facts/vocabulary';
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import { logger } from '@/lib/observability/logger';
import { getPermissionsForRole } from '@/lib/permissions';
import { chargeModelCalls } from '@/lib/security/model-call-rate-limit';
import type { FactExtractor } from '@/lib/sources/extractor';
import { sanitiseFactForStorage } from '@/lib/sources/storage';
import { deploymentPackRecordMode } from './interview-packs';
import { modelUnavailableReason, nightlyShareSpent, type NightlyShare } from './model-calls';
import { env } from '@/env';
import { monthlyCeilingMicroUsd } from '@/lib/ai/config';
import { periodStartOf } from '@/lib/ai/call-record';
import { bookSourceSet } from './source-common';
import { bookNamesOf } from './source-library';

export interface BibleFactDeps {
    /** The extractor (tests: a fake); a BACKFILL extraction hands it the shares its calls are held to (4.H-b: the day's and the month's). */
    extractor?: (ctx: WorkspaceRequestContext, shares: readonly NightlyShare[]) => FactExtractor;
    /** The workspace's daily backfill share in µUSD (tests: a figure of their own; default `BACKFILL_DAILY_SHARE` of the month's ceiling). */
    dailyCapMicroUsd?: number;
    /** The workspace's backfill share of the calendar month in µUSD (tests; default `BACKFILL_MONTHLY_SHARE` of the month's ceiling, D32). */
    monthlyCapMicroUsd?: number;
    recordMode?: PackRecordMode;
    gate?: () => BibleFactGateVerdict;
    signal?: AbortSignal;
    /** Waits out a limited minute (tests: instant). */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** Charges one model call to the workspace's minute (D17). */
    charge?: (workspaceId: string, calls: number) => void;
    now?: () => Date;
    /** A call's worst case in µUSD over its data blocks (tests: a figure of their own). */
    worstCase?: (blocks: readonly AuthorDataBlock[]) => number;
}

/** The state a pay-off moves a thread of each kind to (Phase 4.2). */
const CLOSED_STATE_OF: Readonly<Record<string, string>> = Object.freeze({ PROMISE: 'PAID_OFF', CLUE: 'REVEALED', OPEN_QUESTION: 'RESOLVED' });

/** How long one extraction waits out a full model-call minute at most before it stops MODEL_RATE_LIMITED. */
export const MODEL_RATE_WAIT_MAX_MS = 60_000;
/** Live facts read about a subject at most (the resolve's other side; the call is shown the first `EXISTING_FACTS_SHOWN_MAX`). */
export const LIVE_FACTS_READ_MAX = 400;

interface RunMetrics {
    sectionsChanged: number;
    /** Phase 4.2: threads proposed, and refused by code. */
    threadsProposed?: number;
    drafted: number;
    kept: number;
    refusals: Record<string, number>;
    callIds: string[];
    duplicatesInVersion: number;
    modelOtherSubject: number;
    /** Calls the version was sent in (its changed sections, bounded: the D27 addendum). */
    calls: number;
    /** 4.H-a (#60 item 2): calls the guard refused (or that repeat the prompt), and the sections they carried: no fact. */
    refusedCalls?: number;
    refusedSections?: number;
    /** 4.H-b (D32): sections the guard refused under older rules, sent again under the current ones. */
    guardRetriedSections?: number;
    /** 4.H-b (D31, D32): a backfill extraction (its purpose and the daily share). */
    backfill?: boolean;
    errorCode?: string;
}

type Ended = { ran: boolean; outcome: FactExtractionOutcome | null };

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

/** Stops that wait on the deployment or the month, not on the extraction: they count no attempt (4.H-b: nor the backfill's daily or monthly share). */
const UNCOUNTED_STOPS: ReadonlySet<FactExtractionOutcome> = new Set(['CEILING', 'KILL_SWITCH', 'DAILY_SHARE', 'MONTHLY_SHARE']);

function statusOf(outcome: FactExtractionOutcome): FactExtractionStatus {
    if (outcome === 'OK' || outcome === 'NO_CHANGE') return 'DONE';
    if (outcome === 'ATTEMPTS_SPENT') return 'FAILED';
    return RESUMABLE_EXTRACTION_OUTCOMES.has(outcome) ? 'STOPPED' : 'SKIPPED';
}

async function end(
    scope: { workspaceId: string; requestId: string; userId?: string },
    row: FactExtractionRow,
    outcome: FactExtractionOutcome,
    metrics: Partial<RunMetrics>,
    now: Date,
    claim?: Date,
): Promise<Ended> {
    const status = statusOf(outcome);
    await runInWorkspaceContext(scope, (db) =>
        FactExtractionRepository.finish(db, scope.workspaceId, row.id, {
            status,
            outcome,
            from: claim ? ['RUNNING'] : ['QUEUED'],
            claim,
            // Owner decision (2026-11-21): a stop at the ceiling or the kill switch spends no attempt, so waiting out a
            // month (or a switched-off deployment) never ends a save's extraction ATTEMPTS_SPENT.
            refundAttempt: UNCOUNTED_STOPS.has(outcome),
            nextAttemptAt: status === 'STOPPED' ? new Date(now.getTime() + FACT_EXTRACTION_RETRY_MS) : null,
            metrics: metrics as unknown as Prisma.InputJsonValue,
            at: now,
        }),
    );
    return { ran: true, outcome };
}

interface Subject {
    owner: FactOwner;
    /** The entry's subjects by name, and the element each is (the element itself; a relation's two ends). */
    names: string[];
    elementIds: string[];
    kind: BibleKind;
}

interface Looked {
    row: FactExtractionRow;
    ctx: WorkspaceRequestContext | null;
    skip: FactExtractionOutcome | null;
}

/** Step 1 (the header): the row, and why it is not run, if it is not. */
async function look(db: PrismaTx, scope: { workspaceId: string; requestId: string }, extractionId: string): Promise<Looked | null> {
    const row = await FactExtractionRepository.find(db, scope.workspaceId, extractionId);
    if (!row || row.status !== 'QUEUED') return null;
    const skip = (outcome: FactExtractionOutcome): Looked => ({ row, ctx: null, skip: outcome });
    if (row.attempts > FACT_EXTRACTION_ATTEMPTS_MAX) return skip('ATTEMPTS_SPENT');
    if (!(await BookRepository.find(db, scope.workspaceId, row.bookId))) return skip('BOOK_DELETED');
    let authorId: string | null;
    if (row.kind === 'BIBLE_VERSION') {
        const version = await BibleVersionReadRepository.elementVersion(db, scope.workspaceId, row.bibleVersionId!);
        if (!version || !(await BibleElementRepository.find(db, scope.workspaceId, row.bookId, row.elementId!))) return skip('SUBJECT_GONE');
        if ((await BibleVersionReadRepository.newestElementVersionId(db, scope.workspaceId, row.elementId!)) !== version.id) return skip('SUPERSEDED');
        authorId = version.authorId;
    } else {
        const version = await BibleVersionReadRepository.relationVersion(db, scope.workspaceId, row.relationVersionId!);
        if (!version || !(await BibleRelationRepository.find(db, scope.workspaceId, row.bookId, row.relationId!))) return skip('SUBJECT_GONE');
        if ((await BibleVersionReadRepository.newestRelationVersionId(db, scope.workspaceId, row.relationId!)) !== version.id) return skip('SUPERSEDED');
        authorId = version.authorId;
    }
    const slug = await WorkspaceRepository.findSlug(db, scope.workspaceId);
    const membership = authorId ? await MembershipRepository.findForUser(db, scope.workspaceId, authorId) : null;
    if (slug && membership && authorId && getPermissionsForRole(membership.role).bible.edit) {
        return { row, skip: null, ctx: { requestId: scope.requestId, userId: authorId, workspaceId: scope.workspaceId, workspaceSlug: slug, role: membership.role, permissions: getPermissionsForRole(membership.role) } };
    }
    // 4.H-b (D31): a BACKFILL row reads an entry saved before 4.1, often by someone long gone. The backfill is the
    // product's own catching up, not the author's act, so it runs as the workspace's longest-standing OWNER (else
    // EDITOR), as the nightly continuity check does; a SAVE row still runs only as the version's author.
    if (row.origin === 'BACKFILL' && slug) {
        for (const role of ['OWNER', 'EDITOR'] as const) {
            const m = await MembershipRepository.oldestOfRole(db, scope.workspaceId, role);
            const permissions = m ? getPermissionsForRole(m.role) : null;
            if (m && permissions?.bible.edit) return { row, skip: null, ctx: { requestId: scope.requestId, userId: m.userId, workspaceId: scope.workspaceId, workspaceSlug: slug, role: m.role, permissions } };
        }
    }
    return skip('AUTHOR_NOT_PERMITTED');
}

/** One call's answer and what it was shown. */
interface CallOutput {
    output: unknown;
    sent: string;
    shown: number;
    /** Phase 4.2: how many open threads the call was shown (a pay-off names one of them). */
    threadsShown: number;
}

interface Prepared {
    subject: Subject;
    entry: RenderedEntry;
    whole: string;
    /** The body sections changed since the baseline, and (4.H-b, D32) those refused under older guard rules (sent in bounded calls, `call-plan.ts`). */
    changedSections: EntrySection[];
    changed: number;
    /** 4.H-b (D32): sections retried under newer guard rules, and refusals carried forward unchanged from the baseline. */
    retried: string[];
    carried: GuardRefusedSection[];
    shown: LiveFact[];
    bookNames: string[];
    nameToId: (name: string | null) => string | null;
    /** Phase 4.2: the book's open threads (shown to each call, oldest first) and the story clock (D25). */
    openThreads: Array<{ id: string; kind: string; title: string }>;
    clock: StoryClock;
}

function asLive(f: BibleFactRow | StoryFactRow, owner: FactOwner, bible: BibleFactRow | null): LiveFact {
    const sameOwner = bible !== null && (owner.kind === 'BIBLE_VERSION' ? bible.elementId === owner.id : bible.relationId === owner.id);
    return {
        id: f.id,
        key: bible?.dedupeKey ?? null,
        predicate: f.predicate,
        subjectElementId: f.subjectElementId,
        objectLiteral: f.objectLiteral,
        statement: f.statement,
        storyTimeFrom: f.storyTimeFrom,
        storyTimeTo: f.storyTimeTo,
        quote: f.quote,
        sameOwner,
        ownerElementId: bible?.elementId ?? null,
        versionId: bible ? (bible.bibleVersionId ?? bible.relationVersionId) : null,
    };
}

/** The live facts a version is resolved against: the book's bible facts about its subject(s) and the book library's confirmed source facts about them. */
async function liveFactsFor(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, subject: Subject, keys: readonly string[] = []): Promise<LiveFact[]> {
    // 4.H-a (#60 item 1): the claims this version makes, read BY KEY first, so a held claim past the cap below is
    // found (provenance) rather than inserted again (a unique violation that ended the run INTERNAL and looped).
    const held = await BibleFactRepository.listLiveByKeys(db, ctx.workspaceId, bookId, keys);
    const bible = await BibleFactRepository.listLiveAbout(db, ctx.workspaceId, bookId, subject.elementIds, LIVE_FACTS_READ_MAX);
    // Facts the entry owns whose subject link went (an end deleted) are still the entry's: read them by owner too.
    const owned = await BibleFactRepository.listLiveOwnedBy(db, ctx.workspaceId, bookId, subject.owner.kind === 'BIBLE_VERSION' ? { elementId: subject.owner.id } : { relationId: subject.owner.id }, LIVE_FACTS_READ_MAX);
    // Only the BOOK's own library: a series fact is shared with other books, and is never proposed for invalidation by one of them (4.2's overrides).
    const set = await bookSourceSet(db, ctx, bookId);
    const sourced = await BibleFactRepository.listConfirmedSourceFactsAbout(db, ctx.workspaceId, set.bookSourceIds, subject.elementIds, LIVE_FACTS_READ_MAX);
    const seen = new Set<string>();
    const out: LiveFact[] = [];
    for (const f of [...held, ...owned, ...bible]) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        out.push(asLive(f, subject.owner, f));
    }
    for (const f of sourced) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        out.push(asLive(f, subject.owner, null));
    }
    return out;
}

/** Step 2's reads (in the claim's transaction). */
async function prepare(db: PrismaTx, ctx: WorkspaceRequestContext, row: FactExtractionRow): Promise<Prepared | null> {
    const names = await bookNamesOf(db, ctx, row.bookId);
    const byKey = new Map<string, string | null>();
    for (const n of names) {
        const key = nameKey(n.name);
        byKey.set(key, byKey.has(key) ? null : n.id);
    }
    const nameToId = (name: string | null) => (name ? (byKey.get(nameKey(name)) ?? null) : null);
    let subject: Subject;
    let entry: RenderedEntry;
    let baseline: RenderedEntry | null = null;
    let baselineRefused: GuardRefusedSection[] = [];
    if (row.kind === 'BIBLE_VERSION') {
        const version = await BibleVersionReadRepository.elementVersion(db, ctx.workspaceId, row.bibleVersionId!);
        if (!version) return null;
        const snapshot = parseSnapshot(version.snapshot);
        entry = renderElementEntry(snapshot);
        const baseRow = await FactExtractionRepository.baselineForElement(db, ctx.workspaceId, row.elementId!, version.id);
        const base = baseRow ? await BibleVersionReadRepository.elementVersion(db, ctx.workspaceId, baseRow.versionId) : null;
        if (base) {
            baseline = renderElementEntry(parseSnapshot(base.snapshot));
            baselineRefused = readGuardRefused(baseRow?.guardRefused);
        }
        subject = { owner: { kind: 'BIBLE_VERSION', id: row.elementId! }, names: [snapshot.element.name], elementIds: [row.elementId!], kind: snapshot.element.kind as BibleKind };
    } else {
        const version = await BibleVersionReadRepository.relationVersion(db, ctx.workspaceId, row.relationVersionId!);
        const relation = await BibleRelationRepository.findWithEnds(db, ctx.workspaceId, row.bookId, row.relationId!);
        if (!version || !relation) return null;
        const ends = { fromKind: relation.from.kind as BibleKind, fromName: relation.from.name, toName: relation.to.name };
        entry = renderRelationEntry(parseRelationSnapshot(version.snapshot), ends);
        const baseRow = await FactExtractionRepository.baselineForRelation(db, ctx.workspaceId, row.relationId!, version.id);
        const base = baseRow ? await BibleVersionReadRepository.relationVersion(db, ctx.workspaceId, baseRow.versionId) : null;
        if (base) {
            baseline = renderRelationEntry(parseRelationSnapshot(base.snapshot), ends);
            baselineRefused = readGuardRefused(baseRow?.guardRefused);
        }
        subject = { owner: { kind: 'RELATION_VERSION', id: row.relationId! }, names: [relation.from.name, relation.to.name], elementIds: [relation.from.id, relation.to.id], kind: relation.from.kind as BibleKind };
    }
    // 4.H-b (D32): the sections the baseline's guard refused under OLDER rules are sent again with the changed ones.
    const retry = guardRetryPlan({ body: entry.body, changed: changedSections(entry, baseline), baselineRefused, rulesVersion: GUARD_RULES_VERSION });
    const changed = retry.send;
    const live = await liveFactsFor(db, ctx, row.bookId, subject);
    // Phase 4.2 (D28): the open threads a pay-off may name, and the story order a rule reads as a fact's time.
    const openThreads = await StoryThreadRepository.listOpen(db, ctx.workspaceId, row.bookId, OPEN_THREADS_SHOWN_MAX);
    const placed = await placedElementsOf(db, ctx.workspaceId, row.bookId, CLOCK_ELEMENTS_MAX + 1);
    const clock = placed.length > CLOCK_ELEMENTS_MAX ? NO_ORDER : storyClock(placed.map((e) => ({ id: e.id, kind: e.kind, name: e.name, orderRank: e.orderRank! })));
    return {
        openThreads,
        clock,
        subject,
        entry,
        whole: entryText(entry),
        changedSections: changed,
        changed: changed.length,
        retried: retry.retried,
        carried: retry.carried,
        shown: live.slice(0, EXISTING_FACTS_SHOWN_MAX),
        bookNames: names.map((n) => n.name),
        nameToId,
    };
}

/** 4.H-b (D32): the backfill's daily share: its purpose's spend in the last day, at most a tenth of the month's ceiling. */
export function backfillShare(at: Date, capMicroUsd?: number): NightlyShare {
    return { purpose: BIBLE_FACTS_BACKFILL_PURPOSE, since: new Date(at.getTime() - BACKFILL_DAY_WINDOW_MS), capMicroUsd: capMicroUsd ?? Math.floor(BACKFILL_DAILY_SHARE * monthlyCeilingMicroUsd(env)) };
}

/**
 * 4.H-b (D32, owner decision 2026-11-27): the backfill's share of the CALENDAR MONTH (UTC): its purpose's spend since
 * the month began, at most half the month's ceiling. Refused at the ledger as `MONTHLY_SHARE`.
 */
export function backfillMonthlyShare(at: Date, capMicroUsd?: number): NightlyShare {
    return { purpose: BIBLE_FACTS_BACKFILL_PURPOSE, since: periodStartOf(at), capMicroUsd: capMicroUsd ?? Math.floor(BACKFILL_MONTHLY_SHARE * monthlyCeilingMicroUsd(env)), limit: 'MONTHLY_SHARE' };
}

/**
 * Which of the backfill's shares has no room for `worstMicroUsd` more, read in the caller's transaction (no lock: the
 * ledger asks again under its spend lock as each call reserves). The month first: it is the longer wait.
 */
export async function backfillShareStop(db: PrismaTx, ctx: Pick<WorkspaceRequestContext, 'workspaceId'>, shares: { daily: NightlyShare; monthly: NightlyShare }, worstMicroUsd: number): Promise<'MONTHLY_SHARE' | 'DAILY_SHARE' | null> {
    if ((await nightlyShareSpent(db, ctx, shares.monthly)) + worstMicroUsd > shares.monthly.capMicroUsd) return 'MONTHLY_SHARE';
    if ((await nightlyShareSpent(db, ctx, shares.daily)) + worstMicroUsd > shares.daily.capMicroUsd) return 'DAILY_SHARE';
    return null;
}

/** Run one extraction (the job's body). */
export async function executeBibleFactExtraction(payload: { workspaceId: string; extractionId: string }, deps: BibleFactDeps = {}): Promise<Ended> {
    const now = deps.now ?? (() => new Date());
    const scope = { workspaceId: payload.workspaceId, requestId: randomUUID() };
    const metrics: RunMetrics = { sectionsChanged: 0, drafted: 0, kept: 0, refusals: {}, callIds: [], duplicatesInVersion: 0, modelOtherSubject: 0, calls: 0 };

    const looked = await runInWorkspaceContext(scope, (db) => look(db, scope, payload.extractionId));
    if (!looked) return { ran: false, outcome: null };
    const { row } = looked;
    if (looked.skip || !looked.ctx) return end(scope, row, looked.skip ?? 'AUTHOR_NOT_PERMITTED', {}, now());
    const ctx = looked.ctx;
    const unavailable = modelUnavailableReason();
    if (unavailable) return end(ctx, row, unavailable === 'AI_DISABLED' ? 'KILL_SWITCH' : 'AI_UNAVAILABLE', { errorCode: unavailable }, now());
    const verdict = (deps.gate ?? (() => bibleFactGate(deps.recordMode ?? deploymentPackRecordMode())))();
    if (!verdict.mounted) return end(ctx, row, 'NOT_EVALUATED', { errorCode: verdict.reason }, now());

    const claimed = await runInWorkspaceContext(ctx, async (db) => {
        const at = now();
        if (!(await FactExtractionRepository.claim(db, ctx.workspaceId, row.id, at))) return null;
        return { claim: at, prepared: await prepare(db, ctx, row) };
    });
    if (!claimed) return { ran: false, outcome: null };
    const { claim, prepared } = claimed;
    if (!prepared) return end(ctx, row, 'SUBJECT_GONE', {}, now(), claim);
    metrics.sectionsChanged = prepared.changed;

    // 4.H-b (D31, D32): a BACKFILL row's calls are recorded under the backfill's purpose and held to its daily share and
    // its share of the calendar month (owner decision 2026-11-27).
    const at = now();
    const shares = row.origin === 'BACKFILL' ? { daily: backfillShare(at, deps.dailyCapMicroUsd), monthly: backfillMonthlyShare(at, deps.monthlyCapMicroUsd) } : undefined;
    if (shares) metrics.backfill = true;
    if (prepared.retried.length > 0) metrics.guardRetriedSections = prepared.retried.length;
    try {
        const outputs: CallOutput[] = [];
        const refused: FactExtractionOutcome[] = [];
        /** 4.H-b (D32): the keys of every section a refused call carried (recorded under the current guard rules). */
        const refusedKeys = new Set<string>();
        if (prepared.changed > 0) {
            // Bounded calls (the D27 addendum): pieces of at most BIBLE_FACT_PIECE_MAX_CHARS, each call's worst case
            // inside the per-call cost budget — refused, nothing sent, when even the smallest call is not.
            // 4.H-b (D32): a section retried under newer guard rules goes in calls of its OWN, after the changed ones, so a
            // second refusal never takes a changed section's facts down with it — and EACH retried section alone (the
            // 4.H-b review): a refused call records every section it carried, so an innocent section first refused only
            // because it shared a call with the bad one would, packed with it again, be refused again with it, and
            // never be read under the new rules.
            const retried = new Set(prepared.retried);
            const planOf = (sections: readonly EntrySection[]) =>
                planBibleFactCalls({
                    entry: prepared.entry,
                    changed: sections,
                    subjects: prepared.subject.names,
                    shown: prepared.shown,
                    bookNames: prepared.bookNames,
                    openThreads: prepared.openThreads,
                    budgetMicroUsd: BIBLE_FACTS_CALL_COST_BUDGET_MICRO_USD,
                    maxChars: BIBLE_FACT_PIECE_MAX_CHARS,
                    minChars: BIBLE_FACT_PIECE_MIN_CHARS,
                    worst: deps.worstCase ?? ((blocks) => bibleFactsCallWorstCase(blocks)),
                });
            const fresh = planOf(prepared.changedSections.filter((x) => !retried.has(x.key)));
            const again = [...retried].map((key) => planOf(prepared.changedSections.filter((x) => x.key === key)));
            if (!fresh.ok || again.some((p) => !p.ok)) return end(ctx, row, 'CALL_OVER_BUDGET', { ...metrics, errorCode: 'CALL_OVER_BUDGET' }, now(), claim);
            const plan = { calls: [...fresh.calls, ...again.flatMap((p) => (p.ok ? p.calls : []))] };
            const held = shares ? [shares.daily, shares.monthly] : [];
            const extractor = deps.extractor ? deps.extractor(ctx, held) : defaultBibleFactExtractor(ctx, {}, held);
            for (const call of plan.calls) {
                if (deps.signal?.aborted) return end(ctx, row, 'ABORTED', metrics, now(), claim);
                // The backfill's month and day (D32): this call's worst case must fit what each has left, asked before the
                // call (and again by the ledger as it reserves); past either the row waits, resumable, no attempt counted.
                if (shares) {
                    const stop = await runInWorkspaceContext(ctx, (db) => backfillShareStop(db, ctx, shares, call.worstMicroUsd));
                    if (stop) return end(ctx, row, stop, { ...metrics, errorCode: stop }, now(), claim);
                }
                if (!(await waitForModelRate(ctx, deps.charge ?? chargeModelCalls, deps.sleep ?? defaultSleep, deps.signal))) {
                    return end(ctx, row, deps.signal?.aborted ? 'ABORTED' : 'MODEL_RATE_LIMITED', metrics, now(), claim);
                }
                const result = await extractor.extract({ data: call.blocks, bookId: row.bookId }, deps.signal);
                metrics.calls++;
                metrics.callIds.push(...result.callIds);
                // What the call cost is counted now, in its own transaction, whatever becomes of the run.
                await runInWorkspaceContext(ctx, (db) => FactExtractionRepository.addCost(db, ctx.workspaceId, row.id, result.costMicroUsd));
                if (!result.ok) {
                    metrics.errorCode = result.errorCode;
                    const outcome: FactExtractionOutcome =
                        result.failure === 'KILL_SWITCH' ? 'KILL_SWITCH'
                        : result.failure === 'WORKSPACE_CEILING' ? (result.errorCode === DAILY_SHARE_REFUSED ? 'DAILY_SHARE' : result.errorCode === MONTHLY_SHARE_REFUSED ? 'MONTHLY_SHARE' : 'CEILING')
                        : result.failure === 'AI_UNAVAILABLE' ? 'AI_UNAVAILABLE'
                        : result.failure === 'ABORTED' ? 'ABORTED'
                        : result.failure === 'GUARD_REFUSED' ? 'GUARD_REFUSED'
                        : result.failure === 'PROMPT_INVALID' && result.errorCode === 'REPEATS_PROMPT' ? 'REPEATS_PROMPT'
                        : 'CALL_FAILED';
                    if (outcome === 'GUARD_REFUSED' || outcome === 'REPEATS_PROMPT') {
                        // 4.H-a (#60 item 2): a piece the guard refuses, or one that repeats the prompt, yields nothing — and
                        // ONLY that piece. The other pieces' facts are kept, and the version still becomes the entry's
                        // baseline (DONE), so the refused text is not sent again with every later version: it is sent
                        // again only once the author changes it. Before 4.H-a the whole version ended SKIPPED, the
                        // baseline stayed behind it, and one bad field blocked facts for the whole entry for ever.
                        refused.push(outcome);
                        if (outcome === 'GUARD_REFUSED') for (const k of call.sectionKeys) refusedKeys.add(k);
                        metrics.refusedCalls = (metrics.refusedCalls ?? 0) + 1;
                        metrics.refusedSections = (metrics.refusedSections ?? 0) + call.sections;
                        continue;
                    }
                    return end(ctx, row, outcome, metrics, now(), claim);
                }
                outputs.push({ output: result.output, sent: call.sent, shown: call.shown, threadsShown: call.threadsShown });
            }
        }
        // Every call refused: still DONE (the baseline moves past the refused text), the refusal named as the outcome.
        const settled: FactExtractionOutcome | undefined = outputs.length === 0 && refused.length > 0 ? refused[0] : undefined;
        // 4.H-b (D32): what the guard has refused so far, each under the rules that refused it: the next version's baseline record.
        const guardRefused = refusalsToRecord(prepared.carried, refusedKeys, GUARD_RULES_VERSION);
        return await persist(ctx, row, claim, prepared, outputs, metrics, now, settled, guardRefused);
    } catch (err) {
        logger.error('facts.extraction_failed', { component: 'facts', extractionId: row.id, error: err instanceof Error ? err.name : 'unknown' });
        return end(ctx, row, 'INTERNAL', { ...metrics, errorCode: 'INTERNAL' }, now(), claim);
    }
}

/** Step 4 (the header): one transaction under the book's fact lock; audit last. */
async function persist(
    ctx: WorkspaceRequestContext,
    row: FactExtractionRow,
    claim: Date,
    prepared: Prepared,
    outputs: readonly CallOutput[],
    metrics: RunMetrics,
    now: () => Date,
    settled?: FactExtractionOutcome,
    guardRefused: GuardRefusedSection[] | null = null,
): Promise<Ended> {
    // Each call's answer is held to the text THAT call was shown (the span check per piece); the facts of all the
    // calls are then one version's facts, deduplicated by their claim key in `resolveFacts`.
    const facts: BibleFactDraft[] = [];
    for (const o of outputs) {
        const v = validateBibleFacts(o.output, { sent: o.sent, entry: prepared.whole, headings: [], subjects: prepared.subject.names, shown: o.shown });
        metrics.drafted += v.drafted;
        for (const [code, n] of Object.entries(v.refusals)) metrics.refusals[code] = (metrics.refusals[code] ?? 0) + n;
        for (const f of v.facts) facts.push({ ...f, position: facts.length });
    }
    const validation = { facts };
    // Phase 4.2: each call's threads, held to the text THAT call was shown and the open threads it was shown.
    const threadDrafts: ReturnType<typeof validateBibleThreads>['threads'] = [];
    for (const o of outputs) {
        const v = validateBibleThreads(o.output, { sent: o.sent, entry: prepared.whole, openThreads: prepared.openThreads.slice(0, o.threadsShown) });
        for (const [code, n] of Object.entries(v.refusals)) metrics.refusals[code] = (metrics.refusals[code] ?? 0) + n;
        threadDrafts.push(...v.threads);
    }
    const drafts = validation.facts.map((d) => ({ draft: sanitiseFactForStorage(d), subjectIndex: d.subjectIndex, contradicts: d.contradicts }));
    const owner = prepared.subject.owner;
    const fresh: NewFact[] = drafts.map(({ draft, subjectIndex, contradicts }) => {
        const claimInput = { predicate: draft.predicate, subjectElementId: prepared.subject.elementIds[subjectIndex], objectLiteral: draft.objectLiteral, statement: draft.statement };
        return {
            ...claimInput,
            storyTimeFrom: draft.storyTimeFrom,
            storyTimeTo: draft.storyTimeTo,
            ownerElementId: owner.kind === 'BIBLE_VERSION' ? owner.id : null,
            key: claimKey(ctx.workspaceId, claimParts(owner, claimInput)),
            contradicts,
        };
    });
    const outcome: FactExtractionOutcome = settled ?? (prepared.changed > 0 ? 'OK' : 'NO_CHANGE');
    return runInWorkspaceContext(ctx, async (db) => {
        await BibleFactRepository.lockBook(db, row.bookId);
        const current = await FactExtractionRepository.find(db, ctx.workspaceId, row.id);
        // Still RUNNING under THIS claim: a stale claim re-dispatched belongs to its new worker.
        if (!current || current.status !== 'RUNNING' || current.startedAt?.getTime() !== claim.getTime()) return { ran: false, outcome: null };
        // Still the entry's NEWEST version, asked again under the lock: a newer version saved while this one ran is
        // extracted on its own (from the baseline this one never became), and may already have persisted. Writing this
        // older version's facts after it would propose the newer facts for invalidation by stale ones, and its text
        // would mark the newer facts NO_LONGER_STATED. What the call cost is already counted.
        const newest = row.kind === 'BIBLE_VERSION'
            ? await BibleVersionReadRepository.newestElementVersionId(db, ctx.workspaceId, row.elementId!)
            : await BibleVersionReadRepository.newestRelationVersionId(db, ctx.workspaceId, row.relationId!);
        if (newest !== (row.bibleVersionId ?? row.relationVersionId)) {
            const skipped: FactExtractionOutcome = newest === null ? 'SUBJECT_GONE' : 'SUPERSEDED';
            await FactExtractionRepository.finish(db, ctx.workspaceId, row.id, { status: statusOf(skipped), outcome: skipped, from: ['RUNNING'], claim, metrics: metrics as unknown as Prisma.InputJsonValue, at: now() });
            return { ran: true, outcome: skipped };
        }
        // Read again under the lock: what another extraction of the book wrote meanwhile is resolved against too.
        const live = await liveFactsFor(db, ctx, row.bookId, prepared.subject, fresh.map((f) => f.key));
        const liveIds = new Set(live.map((f) => f.id));
        const plan = resolveFacts({ fresh, shown: prepared.shown, live, entry: prepared.whole, clock: prepared.clock });
        // A fact shown to the call but invalidated (or gone) meanwhile is not proposed.
        plan.contradictions = plan.contradictions.filter((c) => liveIds.has(c.olderId));
        metrics.duplicatesInVersion = plan.counts.duplicatesInVersion;
        metrics.modelOtherSubject = plan.counts.modelOtherSubject;
        const at = now();
        const rows: BibleFactInsert[] = plan.insert.map((i, position) => {
            const { draft, subjectIndex } = drafts[i];
            return {
                sourceKind: owner.kind,
                bookId: row.bookId,
                elementId: owner.kind === 'BIBLE_VERSION' ? owner.id : null,
                relationId: owner.kind === 'RELATION_VERSION' ? owner.id : null,
                bibleVersionId: row.bibleVersionId,
                relationVersionId: row.relationVersionId,
                dedupeKey: fresh[i].key,
                position,
                subjectName: draft.subjectName,
                subjectElementId: prepared.subject.elementIds[subjectIndex],
                predicate: draft.predicate,
                objectElementId: prepared.nameToId(draft.objectLiteral),
                objectLiteral: draft.objectLiteral,
                statement: draft.statement,
                quote: draft.quote,
                quoteStart: draft.quoteStart,
                quoteEnd: draft.quoteEnd,
                storyTimeFrom: draft.storyTimeFrom,
                storyTimeTo: draft.storyTimeTo,
                flags: draft.flags,
            };
        });
        const created = await StoryFactRepository.createBibleFacts(db, ctx.workspaceId, rows, at);
        const idOfNew = new Map(plan.insert.map((i, k) => [i, created[k].id] as const));
        // A fact this very version first stated is not "restated" by it (4.H-a, roadmap item 1: a re-run of the version
        // writes nothing — its own facts are held by key, and gain no provenance row from the version that made them).
        const thisVersion = row.bibleVersionId ?? row.relationVersionId;
        const liveById = new Map(live.map((f) => [f.id, f] as const));
        const provenanceAdded = await FactProvenanceRepository.add(
            db,
            ctx.workspaceId,
            plan.restated
                .filter((r) => liveById.get(r.factId)?.versionId !== thisVersion)
                .map((r) => ({ factId: r.factId, sourceKind: owner.kind, bibleVersionId: row.bibleVersionId, relationVersionId: row.relationVersionId })),
        );
        const proposalsRaised = await FactProposalRepository.raise(db, ctx.workspaceId, [
            ...plan.contradictions.map((c) => ({ bookId: row.bookId, factId: c.olderId, newerFactId: idOfNew.get(c.newIndex)!, reason: 'CONTRADICTED' as const, basis: c.basis, kind: c.kind, extractionId: row.id })),
            ...plan.noLongerStated.map((id) => ({ bookId: row.bookId, factId: id, newerFactId: null, reason: 'NO_LONGER_STATED' as const, basis: 'TEXT' as const, kind: null, extractionId: row.id })),
        ]);
        // Phase 4.2 (D28): the threads, proposed (rule 1), one per claim in the book ever (a rejected one never returns).
        // A pay-off names a thread still open now; one closed meanwhile is not proposed.
        const stillOpen = new Map((await StoryThreadRepository.listOpen(db, ctx.workspaceId, row.bookId, OPEN_THREADS_SHOWN_MAX)).map((t) => [t.id, t] as const));
        const threadRows: ThreadProposalInsert[] = [];
        for (const t of threadDrafts) {
            const target = t.paysOffIndex === null ? null : prepared.openThreads[t.paysOffIndex];
            if (t.op === 'SET_STATE' && (!target || !stillOpen.has(target.id))) continue;
            const proposedState = t.op === 'NEW_THREAD' ? 'OPEN' : CLOSED_STATE_OF[t.kind];
            // A new thread is keyed by its KIND and the entry's own WORDS that set it up, never by the model's title: the
            // title is reworded from call to call, so keying on it let a rejected thread return under a new title.
            const parts = t.op === 'NEW_THREAD' ? ['THREAD', t.kind, contentTokens(t.quote).join(' ') || t.quote] : ['PAY', target!.id, proposedState];
            const clean = sanitiseThreadProposalForStorage({ title: t.title, quote: t.quote });
            threadRows.push({
                bookId: row.bookId,
                op: t.op,
                kind: t.kind,
                title: clean.title,
                proposedState,
                threadId: target?.id ?? null,
                extractionId: row.id,
                bibleVersionId: row.bibleVersionId,
                relationVersionId: row.relationVersionId,
                quote: clean.quote,
                quoteStart: t.quoteStart,
                quoteEnd: t.quoteEnd,
                subjectElementId: prepared.subject.elementIds[0] ?? null,
                dedupeKey: claimKey(ctx.workspaceId, parts),
                flags: t.flags,
            });
        }
        metrics.threadsProposed = await StoryThreadProposalRepository.raise(db, ctx.workspaceId, threadRows);
        metrics.kept = created.length;
        const counts = { factsAdded: created.length, provenanceAdded, proposalsRaised };
        await FactExtractionRepository.finish(db, ctx.workspaceId, row.id, {
            status: 'DONE',
            outcome,
            from: ['RUNNING'],
            claim,
            counts,
            promptVersion: prepared.changed > 0 ? BIBLE_FACTS_PROMPT_VERSION : null,
            metrics: metrics as unknown as Prisma.InputJsonValue,
            at,
            guardRefused: guardRefused as unknown as Prisma.InputJsonValue | null,
        });
        // AUDIT LAST (3.H): the audit lock is held to commit.
        await logEvent(
            ctx,
            { action: 'BIBLE_FACTS_EXTRACTED', entityType: 'BibleFactExtraction', entityId: row.id, details: { bookId: row.bookId, kind: row.kind, outcome, ...counts } },
            { db, actorType: 'SYSTEM' },
        );
        return { ran: true, outcome };
    });
}

/**
 * The workspace's model-call minute (D17): a limited minute is waited out, never failed — the job has nowhere to
 * send a 429. Bounded: past `MODEL_RATE_WAIT_MAX_MS` (or once aborted) it answers false and NO call is charged or
 * made.
 */
export async function waitForModelRate(
    ctx: WorkspaceRequestContext,
    charge: (workspaceId: string, calls: number) => void,
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
    signal?: AbortSignal,
): Promise<boolean> {
    let waited = 0;
    for (;;) {
        try {
            charge(ctx.workspaceId, 1);
            return true;
        } catch (err) {
            if (!(err instanceof RateLimitedError)) throw err;
            if (waited >= MODEL_RATE_WAIT_MAX_MS || signal?.aborted) return false;
            const retry = Number((err.details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs ?? 1_000);
            const ms = Math.min(MODEL_RATE_WAIT_MAX_MS - waited, Math.max(250, Number.isFinite(retry) ? retry : 1_000));
            await sleep(ms, signal);
            waited += ms;
            if (signal?.aborted) return false;
        }
    }
}
