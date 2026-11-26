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
 *   4. PERSIST  under the book's fact lock: validate (4.0's rules plus the
 *               entry's own), key each claim, resolve against the live facts
 *               (`dedupe.ts`), write the new facts CONFIRMED and automatic, the
 *               provenance of each restated one, and a PROPOSAL for each
 *               contradiction and each earlier fact the entry no longer states —
 *               nothing is invalidated (rule 1); then the row DONE; audit last.
 *
 * IDEMPOTENT: a DONE or SKIPPED row is never claimed again, and a resolve run
 * twice over one version writes nothing new (the claim keys, the provenance's
 * and the proposals' unique keys). It never touches the bible or the version.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
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
import { changedSections, entryText, renderElementEntry, renderRelationEntry, sentText, type RenderedEntry } from '@/lib/facts/entry-text';
import { defaultBibleFactExtractor } from '@/lib/facts/model-seam';
import { BIBLE_FACTS_PROMPT_VERSION, bibleFactBlocks, EXISTING_FACTS_SHOWN_MAX } from '@/lib/facts/prompt';
import { bibleFactGate, type BibleFactGateVerdict } from '@/lib/facts/record-gate';
import { validateBibleFacts } from '@/lib/facts/validate';
import { FACT_EXTRACTION_ATTEMPTS_MAX, FACT_EXTRACTION_RETRY_MS, RESUMABLE_EXTRACTION_OUTCOMES, type FactExtractionOutcome, type FactExtractionStatus } from '@/lib/facts/vocabulary';
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import { logger } from '@/lib/observability/logger';
import { getPermissionsForRole } from '@/lib/permissions';
import { chargeModelCalls } from '@/lib/security/model-call-rate-limit';
import type { FactExtractor } from '@/lib/sources/extractor';
import { sanitiseFactForStorage } from '@/lib/sources/storage';
import { deploymentPackRecordMode } from './interview-packs';
import { modelUnavailableReason } from './model-calls';
import { bookSourceSet } from './source-common';
import { bookNamesOf } from './source-library';

export interface BibleFactDeps {
    extractor?: (ctx: WorkspaceRequestContext) => FactExtractor;
    recordMode?: PackRecordMode;
    gate?: () => BibleFactGateVerdict;
    signal?: AbortSignal;
    /** Waits out a limited minute (tests: instant). */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** Charges one model call to the workspace's minute (D17). */
    charge?: (workspaceId: string, calls: number) => void;
    now?: () => Date;
}

/** How long one extraction waits out a full model-call minute at most before it stops MODEL_RATE_LIMITED. */
export const MODEL_RATE_WAIT_MAX_MS = 60_000;
/** Live facts read about a subject at most (the resolve's other side; the call is shown the first `EXISTING_FACTS_SHOWN_MAX`). */
export const LIVE_FACTS_READ_MAX = 400;

interface RunMetrics {
    sectionsChanged: number;
    drafted: number;
    kept: number;
    refusals: Record<string, number>;
    callIds: string[];
    duplicatesInVersion: number;
    modelOtherSubject: number;
    errorCode?: string;
}

type Ended = { ran: boolean; outcome: FactExtractionOutcome | null };

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

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
    if (!slug || !membership || !authorId) return skip('AUTHOR_NOT_PERMITTED');
    const permissions = getPermissionsForRole(membership.role);
    if (!permissions.bible.edit) return skip('AUTHOR_NOT_PERMITTED');
    return { row, skip: null, ctx: { requestId: scope.requestId, userId: authorId, workspaceId: scope.workspaceId, workspaceSlug: slug, role: membership.role, permissions } };
}

interface Prepared {
    subject: Subject;
    entry: RenderedEntry;
    whole: string;
    sent: string;
    changed: number;
    shown: LiveFact[];
    bookNames: string[];
    nameToId: (name: string | null) => string | null;
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
    };
}

/** The live facts a version is resolved against: the book's bible facts about its subject(s) and the book library's confirmed source facts about them. */
async function liveFactsFor(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, subject: Subject): Promise<LiveFact[]> {
    const bible = await BibleFactRepository.listLiveAbout(db, ctx.workspaceId, bookId, subject.elementIds, LIVE_FACTS_READ_MAX);
    // Facts the entry owns whose subject link went (an end deleted) are still the entry's: read them by owner too.
    const owned = await BibleFactRepository.listLiveOwnedBy(db, ctx.workspaceId, bookId, subject.owner.kind === 'BIBLE_VERSION' ? { elementId: subject.owner.id } : { relationId: subject.owner.id }, LIVE_FACTS_READ_MAX);
    // Only the BOOK's own library: a series fact is shared with other books, and is never proposed for invalidation by one of them (4.2's overrides).
    const set = await bookSourceSet(db, ctx, bookId);
    const sourced = await BibleFactRepository.listConfirmedSourceFactsAbout(db, ctx.workspaceId, set.bookSourceIds, subject.elementIds, LIVE_FACTS_READ_MAX);
    const seen = new Set<string>();
    const out: LiveFact[] = [];
    for (const f of [...owned, ...bible]) {
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
    if (row.kind === 'BIBLE_VERSION') {
        const version = await BibleVersionReadRepository.elementVersion(db, ctx.workspaceId, row.bibleVersionId!);
        if (!version) return null;
        const snapshot = parseSnapshot(version.snapshot);
        entry = renderElementEntry(snapshot);
        const baseId = await FactExtractionRepository.baselineForElement(db, ctx.workspaceId, row.elementId!, version.id);
        const base = baseId ? await BibleVersionReadRepository.elementVersion(db, ctx.workspaceId, baseId) : null;
        if (base) baseline = renderElementEntry(parseSnapshot(base.snapshot));
        subject = { owner: { kind: 'BIBLE_VERSION', id: row.elementId! }, names: [snapshot.element.name], elementIds: [row.elementId!], kind: snapshot.element.kind as BibleKind };
    } else {
        const version = await BibleVersionReadRepository.relationVersion(db, ctx.workspaceId, row.relationVersionId!);
        const relation = await BibleRelationRepository.findWithEnds(db, ctx.workspaceId, row.bookId, row.relationId!);
        if (!version || !relation) return null;
        const ends = { fromKind: relation.from.kind as BibleKind, fromName: relation.from.name, toName: relation.to.name };
        entry = renderRelationEntry(parseRelationSnapshot(version.snapshot), ends);
        const baseId = await FactExtractionRepository.baselineForRelation(db, ctx.workspaceId, row.relationId!, version.id);
        const base = baseId ? await BibleVersionReadRepository.relationVersion(db, ctx.workspaceId, baseId) : null;
        if (base) baseline = renderRelationEntry(parseRelationSnapshot(base.snapshot), ends);
        subject = { owner: { kind: 'RELATION_VERSION', id: row.relationId! }, names: [relation.from.name, relation.to.name], elementIds: [relation.from.id, relation.to.id], kind: relation.from.kind as BibleKind };
    }
    const changed = changedSections(entry, baseline);
    const live = await liveFactsFor(db, ctx, row.bookId, subject);
    return {
        subject,
        entry,
        whole: entryText(entry),
        sent: sentText(entry, changed),
        changed: changed.length,
        shown: live.slice(0, EXISTING_FACTS_SHOWN_MAX),
        bookNames: names.map((n) => n.name),
        nameToId,
    };
}

/** Run one extraction (the job's body). */
export async function executeBibleFactExtraction(payload: { workspaceId: string; extractionId: string }, deps: BibleFactDeps = {}): Promise<Ended> {
    const now = deps.now ?? (() => new Date());
    const scope = { workspaceId: payload.workspaceId, requestId: randomUUID() };
    const metrics: RunMetrics = { sectionsChanged: 0, drafted: 0, kept: 0, refusals: {}, callIds: [], duplicatesInVersion: 0, modelOtherSubject: 0 };

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

    try {
        let output: unknown = { facts: [] };
        if (prepared.changed > 0) {
            if (deps.signal?.aborted) return end(ctx, row, 'ABORTED', metrics, now(), claim);
            if (!(await waitForModelRate(ctx, deps.charge ?? chargeModelCalls, deps.sleep ?? defaultSleep, deps.signal))) {
                return end(ctx, row, deps.signal?.aborted ? 'ABORTED' : 'MODEL_RATE_LIMITED', metrics, now(), claim);
            }
            const extractor = (deps.extractor ?? defaultBibleFactExtractor)(ctx);
            const data = bibleFactBlocks({ text: prepared.sent, subjects: prepared.subject.names, existing: prepared.shown, bookNames: prepared.bookNames });
            const result = await extractor.extract({ data, bookId: row.bookId }, deps.signal);
            metrics.callIds.push(...result.callIds);
            // What the call cost is counted now, in its own transaction, whatever becomes of the run.
            await runInWorkspaceContext(ctx, (db) => FactExtractionRepository.addCost(db, ctx.workspaceId, row.id, result.costMicroUsd));
            if (!result.ok) {
                metrics.errorCode = result.errorCode;
                const outcome: FactExtractionOutcome =
                    result.failure === 'KILL_SWITCH' ? 'KILL_SWITCH'
                    : result.failure === 'WORKSPACE_CEILING' ? 'CEILING'
                    : result.failure === 'AI_UNAVAILABLE' ? 'AI_UNAVAILABLE'
                    : result.failure === 'ABORTED' ? 'ABORTED'
                    : result.failure === 'GUARD_REFUSED' ? 'GUARD_REFUSED'
                    : result.failure === 'PROMPT_INVALID' && result.errorCode === 'REPEATS_PROMPT' ? 'REPEATS_PROMPT'
                    : 'CALL_FAILED';
                return end(ctx, row, outcome, metrics, now(), claim);
            }
            output = result.output;
        }
        return await persist(ctx, row, claim, prepared, output, metrics, now);
    } catch (err) {
        logger.error('facts.extraction_failed', { component: 'facts', extractionId: row.id, error: err instanceof Error ? err.name : 'unknown' });
        return end(ctx, row, 'INTERNAL', { ...metrics, errorCode: 'INTERNAL' }, now(), claim);
    }
}

/** Step 4 (the header): one transaction under the book's fact lock; audit last. */
async function persist(ctx: WorkspaceRequestContext, row: FactExtractionRow, claim: Date, prepared: Prepared, output: unknown, metrics: RunMetrics, now: () => Date): Promise<Ended> {
    const validation = validateBibleFacts(output, { sent: prepared.sent, entry: prepared.whole, headings: [], subjects: prepared.subject.names, shown: prepared.shown.length });
    metrics.drafted = validation.drafted;
    metrics.refusals = validation.refusals;
    const drafts = validation.facts.map((d) => ({ draft: sanitiseFactForStorage(d), subjectIndex: d.subjectIndex, contradicts: d.contradicts }));
    const owner = prepared.subject.owner;
    const fresh: NewFact[] = drafts.map(({ draft, subjectIndex, contradicts }) => {
        const claimInput = { predicate: draft.predicate, subjectElementId: prepared.subject.elementIds[subjectIndex], objectLiteral: draft.objectLiteral, statement: draft.statement };
        return { ...claimInput, storyTimeFrom: draft.storyTimeFrom, storyTimeTo: draft.storyTimeTo, key: claimKey(ctx.workspaceId, claimParts(owner, claimInput)), contradicts };
    });
    const outcome: FactExtractionOutcome = prepared.changed > 0 ? 'OK' : 'NO_CHANGE';
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
        const live = await liveFactsFor(db, ctx, row.bookId, prepared.subject);
        const liveIds = new Set(live.map((f) => f.id));
        const plan = resolveFacts({ fresh, shown: prepared.shown, live, entry: prepared.whole });
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
        const provenanceAdded = await FactProvenanceRepository.add(
            db,
            ctx.workspaceId,
            plan.restated.map((r) => ({ factId: r.factId, sourceKind: owner.kind, bibleVersionId: row.bibleVersionId, relationVersionId: row.relationVersionId })),
        );
        const proposalsRaised = await FactProposalRepository.raise(db, ctx.workspaceId, [
            ...plan.contradictions.map((c) => ({ bookId: row.bookId, factId: c.olderId, newerFactId: idOfNew.get(c.newIndex)!, reason: 'CONTRADICTED' as const, basis: c.basis, extractionId: row.id })),
            ...plan.noLongerStated.map((id) => ({ bookId: row.bookId, factId: id, newerFactId: null, reason: 'NO_LONGER_STATED' as const, basis: 'TEXT' as const, extractionId: row.id })),
        ]);
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
async function waitForModelRate(
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
