/**
 * Reviewing enrichment proposals (Phase 2.5): read a session's proposals, and
 * accept, edit then accept, reject, or bulk-accept them. RULE 1 LIVES HERE: no
 * model output changes the bible until the author accepts it, and every
 * accepted change is a new version naming the answers it came from.
 *
 *   accept        a FIELD proposal: under the element's lock, the request's
 *                 `baseVersion` must be the element's latest (1.H: 409
 *                 VERSION_CONFLICT otherwise, nothing written); an element
 *                 that moved since the proposal was made is accepted only when
 *                 the author says they reviewed its current value
 *                 (`reviewedCurrent`, 409 PROPOSAL_OUTDATED otherwise); the
 *                 operation must still fit the field (ADD into an empty field,
 *                 UPDATE or REMOVE of a filled one: 409 PROPOSAL_STALE). The
 *                 value goes through the bible's own versioned save
 *                 (`writeFieldValues`, then `recordVersion` with source
 *                 INTERVIEW and `sourceAnswerIds` = the proposal's citations).
 *                 Any other PENDING proposal for the same field is SUPERSEDED.
 *                 A NEW_ELEMENT proposal creates the element through the 1.1
 *                 create path (`createElementInTx`), its first version
 *                 INTERVIEW and naming the answers.
 *   edit+accept   the same, with the author's value (sanitised by
 *                 `normaliseFieldValue`; a new element's name and summary by
 *                 `requiredLine` / `optionalBlock`); recorded EDITED_ACCEPTED
 *                 when it differs from the proposal. A REMOVE has nothing to
 *                 edit; an edit cannot empty a field (reject instead).
 *   reject        REJECTED; nothing is written to the bible.
 *   flags         a proposal flagged POSSIBLE_INSTRUCTION (its text addresses
 *                 the product itself; owner decision D14) is shown as such and
 *                 accepted only one by one, by the same explicit accept.
 *   bulk accept   only unflagged ADD proposals into fields STILL EMPTY when accepted,
 *                 each naming its element's reviewed version; one version per
 *                 element, naming every answer behind it. One ineligible item
 *                 refuses the whole request (409 BULK_INELIGIBLE), nothing
 *                 written.
 *
 * A decision is a conditional update from PENDING (`decide`): of two at once,
 * one lands and the other is 409 PROPOSAL_DECIDED. The database holds the
 * rest (`enrichment_proposal_fixed`: a proposal's content never changes).
 *
 * Permissions: `bible.view` reads (every member reads the bible and its
 * interviews), `bible.edit` decides.
 *
 * THIS MODULE IS ON THE BIBLE'S WRITE PATH (it takes `writeFieldValues` and
 * `recordVersion`), so it imports no dial, pack or model module, even for
 * types (`tests/guards/dials-stay-off-the-bible-write-path.test.ts`).
 */
import type { BibleElementKind } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository, BibleFieldRepository, BibleVersionRepository } from '@/app-layer/repositories/bible.repository';
import { EnrichmentAnswerReads, EnrichmentProposalRepository, ReconcileRunRepository, type ProposalRow } from '@/app-layer/repositories/enrichment.repository';
import { InterviewRoundRepository, InterviewSessionRepository } from '@/app-layer/repositories/interview.repository';
import { AcceptProposalInput, BulkAcceptInput, ProposalIdParam } from '@/app-layer/schemas/enrichment';
import { CHANGE_SUMMARY_MAX, ELEMENT_NAME_MAX, ELEMENT_SUMMARY_MAX } from '@/app-layer/schemas/bible';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { decodeFieldValue, sameFieldValue, type FieldValue } from '@/lib/bible/field-values';
import type { FieldDef } from '@/lib/bible/template-schema';
import { getFieldDef } from '@/lib/bible/templates';
import { decodeProposedValue } from '@/lib/enrichment/storage';
import { bulkEligible, opFits } from '@/lib/enrichment/review-rules';
import { effectiveRunState, PROPOSAL_FLAGS, type ProposalFlag, type ProposalStatus, type ReconcileOutcome, type StoredOp } from '@/lib/enrichment/vocabulary';
import {
    DERIVED_SLUG_ATTEMPTS,
    isUniqueViolation,
    normaliseFieldEntries,
    optionalBlock,
    readFieldValues,
    recordVersion,
    requireBook,
    requireElement,
    requiredLine,
    slugConflict,
    writeFieldValues,
} from './bible-common';
import { createElementInTx } from './bible-elements';
import { bookHoldsElementName } from './enrichment-names';

/** A session's proposals a review reads at most (it reads one more to say it was cut). */
export const REVIEW_PROPOSALS_MAX = 400;
/** A session's rounds and runs a review reads. */
const REVIEW_ROUNDS_READ = 50;
const FIELDS_PER_ELEMENT = 50;
/** The book's sessions with pending proposals listed at most. */
export const PENDING_SESSIONS_MAX = 50;

// ─── Views ─────────────────────────────────────────────────────────

export interface CitedAnswerView {
    answerId: string;
    question: string;
    questionKind: string;
    /** The reply as text (choice, scale and words joined); null unless ANSWERED. */
    answer: string | null;
    status: 'ANSWERED' | 'SKIPPED' | 'DECIDE_LATER';
}

export interface FieldProposalView {
    id: string;
    kind: 'FIELD';
    roundNumber: number | null;
    status: ProposalStatus;
    elementId: string;
    elementName: string;
    elementKind: BibleElementKind;
    fieldKey: string;
    /** The field's template (the review's editor and its diff read it). */
    field: FieldDef;
    operation: StoredOp;
    proposedValue: FieldValue | null;
    currentValue: FieldValue | null;
    /** The element's version when proposed, and now: a review shows the change when they differ. */
    baseVersion: number;
    currentVersion: number;
    /** Offered for bulk acceptance: a PENDING, unflagged ADD into a field that is still empty. */
    bulkEligible: boolean;
    /** What the author is warned of (D14): POSSIBLE_INSTRUCTION. */
    flags: ProposalFlag[];
    citedAnswerIds: string[];
    decidedAt: string | null;
}

export interface NewElementProposalView {
    id: string;
    kind: 'NEW_ELEMENT';
    roundNumber: number | null;
    status: ProposalStatus;
    newKind: BibleElementKind;
    name: string;
    summary: string | null;
    createdElementId: string | null;
    /** What the author is warned of (D14): POSSIBLE_INSTRUCTION. */
    flags: ProposalFlag[];
    citedAnswerIds: string[];
    decidedAt: string | null;
}

export interface ReviewRunView {
    roundNumber: number | null;
    status: string;
    outcome: ReconcileOutcome | null;
    reviewRequired: boolean;
    refusalReason: string | null;
}

export interface SessionReviewView {
    session: { id: string; bookId: string; scope: string; targetElementId: string | null; targetKind: BibleElementKind | null; status: string };
    fields: FieldProposalView[];
    newElements: NewElementProposalView[];
    answers: Record<string, CitedAnswerView>;
    runs: ReviewRunView[];
    /** The session had more proposals than the review read. */
    truncated: boolean;
}

function answerText(a: { status: string; text: string | null; choice: string | null; scale: number | null }): string | null {
    if (a.status !== 'ANSWERED') return null;
    return [a.choice, a.scale === null ? null : String(a.scale), a.text].filter((p): p is string => p !== null && p !== '').join(' — ') || null;
}

const citationIds = (p: ProposalRow) => p.citations.map((c) => c.answerId);
/** A stored proposal's flags, those of the closed list only. */
const flagsOf = (p: ProposalRow): ProposalFlag[] => p.flags.filter((f): f is ProposalFlag => (PROPOSAL_FLAGS as readonly string[]).includes(f));

/** Every proposal of a session, with the current state of what each targets and the answers each cites (`bible.view`). */
export async function getSessionReview(ctx: WorkspaceRequestContext, bookId: string, sessionId: string): Promise<SessionReviewView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const session = await InterviewSessionRepository.find(db, ctx.workspaceId, bookId, sessionId);
        if (!session) throw new NotFoundError('Interview not found.');
        const rows = await EnrichmentProposalRepository.listForSession(db, ctx.workspaceId, sessionId, REVIEW_PROPOSALS_MAX + 1);
        const proposals = rows.slice(0, REVIEW_PROPOSALS_MAX);
        const rounds = await InterviewRoundRepository.listForSession(db, ctx.workspaceId, sessionId, REVIEW_ROUNDS_READ);
        const numberOf = new Map(rounds.map((r) => [r.id, r.number] as const));

        const elementIds = [...new Set(proposals.flatMap((p) => (p.elementId ? [p.elementId] : [])))];
        const elements = new Map((await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, elementIds)).map((e) => [e.id, e] as const));
        const values = new Map<string, Map<string, FieldValue>>();
        for (const f of await BibleFieldRepository.listForElements(db, ctx.workspaceId, [...elements.keys()], FIELDS_PER_ELEMENT)) {
            if (!values.has(f.elementId)) values.set(f.elementId, new Map());
            values.get(f.elementId)!.set(f.key, decodeFieldValue(f.value));
        }
        const versions = new Map<string, number>();
        for (const id of elements.keys()) versions.set(id, await BibleVersionRepository.latestNumber(db, ctx.workspaceId, id));

        const fields: FieldProposalView[] = [];
        const newElements: NewElementProposalView[] = [];
        for (const p of proposals) {
            const roundNumber = numberOf.get(p.roundId) ?? null;
            if (p.kind === 'NEW_ELEMENT') {
                newElements.push({
                    id: p.id,
                    kind: 'NEW_ELEMENT',
                    roundNumber,
                    status: p.status,
                    newKind: p.newKind!,
                    name: p.newName ?? '',
                    summary: p.newSummary,
                    createdElementId: p.createdElementId,
                    flags: flagsOf(p),
                    citedAnswerIds: citationIds(p),
                    decidedAt: p.decidedAt ? p.decidedAt.toISOString() : null,
                });
                continue;
            }
            const element = elements.get(p.elementId!);
            const def = element ? getFieldDef(element.kind, p.fieldKey!) : undefined;
            if (!element || !def) continue;
            const current = values.get(element.id)?.get(def.key) ?? null;
            fields.push({
                id: p.id,
                kind: 'FIELD',
                roundNumber,
                status: p.status,
                elementId: element.id,
                elementName: element.name,
                elementKind: element.kind,
                fieldKey: def.key,
                field: def,
                operation: p.operation!,
                proposedValue: decodeProposedValue(p.proposedValue),
                currentValue: current,
                baseVersion: p.baseVersion!,
                currentVersion: versions.get(element.id) ?? 0,
                bulkEligible: bulkEligible({ status: p.status, operation: p.operation!, flags: p.flags }, current),
                flags: flagsOf(p),
                citedAnswerIds: citationIds(p),
                decidedAt: p.decidedAt ? p.decidedAt.toISOString() : null,
            });
        }

        const cited = [...new Set(proposals.flatMap(citationIds))];
        const answers: Record<string, CitedAnswerView> = {};
        for (const a of await EnrichmentAnswerReads.listCited(db, ctx.workspaceId, sessionId, cited)) {
            answers[a.id] = { answerId: a.id, question: a.question.text, questionKind: a.question.kind, answer: answerText(a), status: a.status };
        }
        const runs = (await ReconcileRunRepository.listForSession(db, ctx.workspaceId, sessionId, REVIEW_ROUNDS_READ)).map((r) => {
            const m = (r.metrics ?? {}) as { reviewRequired?: boolean; refusalReason?: string };
            const state = effectiveRunState(r);
            return { roundNumber: numberOf.get(r.roundId) ?? null, status: state.status, outcome: state.outcome, reviewRequired: m.reviewRequired ?? false, refusalReason: m.refusalReason ?? null };
        });
        return {
            session: { id: session.id, bookId, scope: session.scope, targetElementId: session.targetElementId, targetKind: session.targetKind, status: session.status },
            fields,
            newElements,
            answers,
            runs,
            truncated: rows.length > REVIEW_PROPOSALS_MAX,
        };
    });
}

/**
 * The rounds of a session whose reconcile run did not run to its end — FAILED
 * (or past its claim, `CLAIM_EXPIRED`) or REFUSED — by number, ascending
 * (`bible.view`; nothing decrypted). The interview page names them so the
 * author knows their answers are waiting (issue #39 item 6); the review page
 * re-runs them.
 */
export async function reconcileRoundsNeedingAttention(ctx: WorkspaceRequestContext, bookId: string, sessionId: string): Promise<number[]> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const rounds = await InterviewRoundRepository.listForSession(db, ctx.workspaceId, sessionId, REVIEW_ROUNDS_READ);
        const numberOf = new Map(rounds.map((r) => [r.id, r.number] as const));
        const out = new Set<number>();
        for (const r of await ReconcileRunRepository.listForSession(db, ctx.workspaceId, sessionId, REVIEW_ROUNDS_READ)) {
            const state = effectiveRunState(r);
            const n = numberOf.get(r.roundId);
            if (n !== undefined && (state.status === 'FAILED' || state.status === 'REFUSED')) out.add(n);
        }
        return [...out].sort((a, b) => a - b);
    });
}

/** The book's interviews with proposals still waiting, and how many each holds (`bible.view`; nothing decrypted). */
export async function listPendingReviews(ctx: WorkspaceRequestContext, bookId: string): Promise<Array<{ sessionId: string; pending: number }>> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        return EnrichmentProposalRepository.pendingBySession(db, ctx.workspaceId, bookId, PENDING_SESSIONS_MAX);
    });
}

// ─── Decisions ─────────────────────────────────────────────────────

export interface DecisionResult {
    proposalId: string;
    status: ProposalStatus;
    /** The version an acceptance wrote, or the element it created. */
    elementId: string | null;
    versionNumber: number | null;
}

async function requirePending(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sessionId: string, proposalId: string): Promise<ProposalRow> {
    await requireBook(db, ctx, bookId);
    const p = await EnrichmentProposalRepository.find(db, ctx.workspaceId, sessionId, ProposalIdParam.parse(proposalId));
    if (!p || p.bookId !== bookId) throw new NotFoundError('Proposal not found.');
    if (p.status !== 'PENDING') throw new ConflictError('This proposal has already been decided.', { reason: 'PROPOSAL_DECIDED', status: p.status });
    if (p.citations.length === 0) throw new ConflictError('The answers this proposal cites are gone.', { reason: 'CITATIONS_GONE' });
    return p;
}

async function decideOrConflict(db: PrismaTx, ctx: WorkspaceRequestContext, proposalId: string, data: Parameters<typeof EnrichmentProposalRepository.decide>[3]): Promise<void> {
    if (!(await EnrichmentProposalRepository.decide(db, ctx.workspaceId, proposalId, data))) {
        throw new ConflictError('This proposal has already been decided.', { reason: 'PROPOSAL_DECIDED' });
    }
}

/** Every other PENDING proposal for the field is overtaken by an acceptance (design 9). */
async function supersedeOthers(db: PrismaTx, ctx: WorkspaceRequestContext, elementId: string, fieldKey: string, acceptedId: string): Promise<number> {
    const others = await EnrichmentProposalRepository.pendingForField(db, ctx.workspaceId, elementId, fieldKey, acceptedId, 100);
    for (const o of others) await EnrichmentProposalRepository.decide(db, ctx.workspaceId, o.id, { status: 'SUPERSEDED', decidedById: ctx.userId });
    return others.length;
}

async function acceptField(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sessionId: string, proposalId: string, input: AcceptProposalInput): Promise<DecisionResult> {
    const peek = await EnrichmentProposalRepository.find(db, ctx.workspaceId, sessionId, ProposalIdParam.parse(proposalId));
    if (!peek || peek.bookId !== bookId) throw new NotFoundError('Proposal not found.');
    if (peek.kind !== 'FIELD') throw new ValidationError('This proposal is for a new element.', { reason: 'EDIT_NOT_ALLOWED' });
    // The element's lock first, then the proposal read under it (a concurrent save of the element queues).
    await BibleElementRepository.lock(db, peek.elementId!);
    const p = await requirePending(db, ctx, bookId, sessionId, proposalId);
    const element = await requireElement(db, ctx, bookId, p.elementId!);
    if (input.baseVersion === undefined) throw new ValidationError('An acceptance names the version it was reviewed against.', { reason: 'BASE_VERSION_REQUIRED' });
    const currentVersion = await BibleVersionRepository.latestNumber(db, ctx.workspaceId, element.id);
    if (currentVersion !== input.baseVersion) {
        throw new ConflictError('This element was saved by someone else since your review began.', { reason: 'VERSION_CONFLICT', currentVersion, baseVersion: input.baseVersion });
    }
    if (p.baseVersion !== currentVersion && !input.reviewedCurrent) {
        throw new ConflictError('The element changed since this was proposed; review its current value first.', { reason: 'PROPOSAL_OUTDATED', currentVersion, proposedAgainst: p.baseVersion });
    }
    const op = p.operation!;
    const key = p.fieldKey!;
    const current = (await readFieldValues(db, ctx, element.id)).get(key) ?? null;
    if (!opFits(op, current)) throw new ConflictError('The field no longer holds what this proposal was made for.', { reason: 'PROPOSAL_STALE', operation: op });

    const proposed = decodeProposedValue(p.proposedValue);
    let value: FieldValue | null = proposed;
    let edited = false;
    if (input.value !== undefined) {
        if (op === 'REMOVE') throw new ValidationError('A removal has no value to edit.', { reason: 'EDIT_NOT_ALLOWED' });
        // The bible's own check and sanitiser for the field's type (refusals by key, as a fields save answers).
        const next = normaliseFieldEntries(element.kind, [{ key, value: input.value }]).get(key) ?? null;
        if (next === null) throw new ValidationError('An edit cannot empty the field; reject the proposal instead.', { reason: 'EDIT_NOT_ALLOWED' });
        edited = !sameFieldValue(next, proposed);
        value = next;
    }
    const changed = await writeFieldValues(db, ctx, element, [{ key, value }]);
    if (changed.length === 0) throw new ValidationError('That would change nothing.', { reason: 'EDIT_CHANGES_NOTHING' });
    await BibleElementRepository.touch(db, ctx.workspaceId, bookId, element.id);
    const answerIds = citationIds(p);
    const version = await recordVersion(db, ctx, bookId, element.id, {
        source: 'INTERVIEW',
        changeSummary: optionalBlock(input.changeSummary, CHANGE_SUMMARY_MAX, 'Change summary') ?? null,
        sourceAnswerIds: answerIds,
    });
    const status: ProposalStatus = edited ? 'EDITED_ACCEPTED' : 'ACCEPTED';
    await decideOrConflict(db, ctx, p.id, { status, decidedById: ctx.userId, versionId: version.id });
    const superseded = await supersedeOthers(db, ctx, element.id, key, p.id);
    await logEvent(
        ctx,
        {
            action: 'ENRICHMENT_PROPOSAL_ACCEPTED',
            entityType: 'EnrichmentProposal',
            entityId: p.id,
            details: { bookId, sessionId, elementId: element.id, fieldKey: key, operation: op, edited, flags: p.flags, versionNumber: version.versionNumber, citedAnswerCount: answerIds.length, superseded },
        },
        { db },
    );
    return { proposalId: p.id, status, elementId: element.id, versionNumber: version.versionNumber };
}

async function acceptNewElement(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sessionId: string, proposalId: string, input: AcceptProposalInput): Promise<DecisionResult> {
    const p = await requirePending(db, ctx, bookId, sessionId, proposalId);
    if (p.kind !== 'NEW_ELEMENT') throw new ValidationError('This proposal changes a field.', { reason: 'EDIT_NOT_ALLOWED' });
    if (input.value !== undefined) throw new ValidationError('A new element takes a name and a summary, not a value.', { reason: 'EDIT_NOT_ALLOWED' });
    const name = input.name !== undefined ? requiredLine(input.name, ELEMENT_NAME_MAX, 'Name') : requiredLine(p.newName ?? '', ELEMENT_NAME_MAX, 'Name');
    const summary = input.summary !== undefined ? (optionalBlock(input.summary, ELEMENT_SUMMARY_MAX, 'Summary') ?? null) : (optionalBlock(p.newSummary, ELEMENT_SUMMARY_MAX, 'Summary') ?? null);
    if (await bookHoldsElementName(db, ctx, bookId, name)) throw new ConflictError('The book already has an element of that name.', { reason: 'ELEMENT_EXISTS' });
    const answerIds = citationIds(p);
    const { element, version } = await createElementInTx(
        db,
        ctx,
        bookId,
        { kind: p.newKind!, name, summary, customLabel: null, fields: [] },
        { source: 'INTERVIEW', changeSummary: optionalBlock(input.changeSummary, CHANGE_SUMMARY_MAX, 'Change summary') ?? null, sourceAnswerIds: answerIds },
    );
    const edited = name !== p.newName || summary !== p.newSummary;
    const status: ProposalStatus = edited ? 'EDITED_ACCEPTED' : 'ACCEPTED';
    await decideOrConflict(db, ctx, p.id, { status, decidedById: ctx.userId, createdElementId: element.id });
    await logEvent(
        ctx,
        {
            action: 'ENRICHMENT_PROPOSAL_ACCEPTED',
            entityType: 'EnrichmentProposal',
            entityId: p.id,
            details: { bookId, sessionId, elementId: element.id, kind: p.newKind, newElement: true, edited, versionNumber: version.versionNumber, citedAnswerCount: answerIds.length },
        },
        { db },
    );
    return { proposalId: p.id, status, elementId: element.id, versionNumber: version.versionNumber };
}

/** Accept one proposal, as proposed or edited (`bible.edit`; the rules in the header). */
export async function acceptProposal(ctx: WorkspaceRequestContext, bookId: string, sessionId: string, proposalId: string, input: unknown): Promise<DecisionResult> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = AcceptProposalInput.parse(input ?? {});
    const kind = await runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        return (await EnrichmentProposalRepository.find(db, ctx.workspaceId, sessionId, ProposalIdParam.parse(proposalId)))?.kind ?? null;
    });
    if (kind === null) throw new NotFoundError('Proposal not found.');
    if (kind === 'FIELD') return runInWorkspaceContext(ctx, (db) => acceptField(db, ctx, bookId, sessionId, proposalId, parsed));
    // A derived slug lost to a concurrent create is retried in a fresh transaction, as `createElement` does.
    for (let attempt = 1; ; attempt++) {
        try {
            return await runInWorkspaceContext(ctx, (db) => acceptNewElement(db, ctx, bookId, sessionId, proposalId, parsed));
        } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            if (attempt >= DERIVED_SLUG_ATTEMPTS) throw slugConflict();
        }
    }
}

/** Reject one proposal: nothing is written to the bible (`bible.edit`). */
export async function rejectProposal(ctx: WorkspaceRequestContext, bookId: string, sessionId: string, proposalId: string): Promise<DecisionResult> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        const p = await requirePending(db, ctx, bookId, sessionId, proposalId).catch((err: unknown) => {
            // A proposal whose answers are gone can still be rejected.
            if (err instanceof ConflictError && (err.details as { reason?: string } | undefined)?.reason === 'CITATIONS_GONE') return null;
            throw err;
        });
        const row = p ?? (await EnrichmentProposalRepository.find(db, ctx.workspaceId, sessionId, proposalId))!;
        await decideOrConflict(db, ctx, row.id, { status: 'REJECTED', decidedById: ctx.userId });
        await logEvent(
            ctx,
            { action: 'ENRICHMENT_PROPOSAL_REJECTED', entityType: 'EnrichmentProposal', entityId: row.id, details: { bookId, sessionId, kind: row.kind, operation: row.operation, fieldKey: row.fieldKey } },
            { db },
        );
        return { proposalId: row.id, status: 'REJECTED' as const, elementId: row.elementId, versionNumber: null };
    });
}

/**
 * Accept several ADD proposals into fields still empty (`bible.edit`): every
 * item checked first, under every element's lock (taken in id order, so two
 * bulk acceptances never wait on each other in a cycle), and nothing written
 * unless every one is eligible. One version per element.
 */
export async function bulkAcceptProposals(ctx: WorkspaceRequestContext, bookId: string, sessionId: string, input: unknown): Promise<DecisionResult[]> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = BulkAcceptInput.parse(input);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const peeked = await EnrichmentProposalRepository.listByIds(db, ctx.workspaceId, sessionId, parsed.items.map((i) => i.proposalId));
        if (peeked.length !== parsed.items.length || peeked.some((p) => p.bookId !== bookId)) throw new NotFoundError('Proposal not found.');
        for (const id of [...new Set(peeked.flatMap((p) => (p.elementId ? [p.elementId] : [])))].sort()) await BibleElementRepository.lock(db, id);
        const rows = await EnrichmentProposalRepository.listByIds(db, ctx.workspaceId, sessionId, parsed.items.map((i) => i.proposalId));
        const base = new Map(parsed.items.map((i) => [i.proposalId, i.baseVersion]));
        const ineligible: string[] = [];
        const byElement = new Map<string, ProposalRow[]>();
        const currentValues = new Map<string, Map<string, FieldValue>>();
        for (const p of rows) {
            // A flagged proposal (D14) is decided one by one, never in bulk.
            if (p.kind !== 'FIELD' || p.operation !== 'ADD' || p.status !== 'PENDING' || p.citations.length === 0 || p.flags.length > 0) {
                ineligible.push(p.id);
                continue;
            }
            if (!currentValues.has(p.elementId!)) currentValues.set(p.elementId!, await readFieldValues(db, ctx, p.elementId!));
            if (currentValues.get(p.elementId!)!.has(p.fieldKey!)) {
                ineligible.push(p.id);
                continue;
            }
            byElement.set(p.elementId!, [...(byElement.get(p.elementId!) ?? []), p]);
        }
        if (ineligible.length > 0) throw new ConflictError('Only proposals that add to an empty field are accepted together.', { reason: 'BULK_INELIGIBLE', proposalIds: ineligible.sort() });
        const results: DecisionResult[] = [];
        for (const [elementId, props] of byElement) {
            const element = await requireElement(db, ctx, bookId, elementId);
            const currentVersion = await BibleVersionRepository.latestNumber(db, ctx.workspaceId, elementId);
            for (const p of props) {
                if (base.get(p.id) !== currentVersion) {
                    throw new ConflictError('This element was saved by someone else since your review began.', { reason: 'VERSION_CONFLICT', currentVersion, baseVersion: base.get(p.id) });
                }
            }
            const keys = new Set(props.map((p) => p.fieldKey!));
            if (keys.size !== props.length) throw new ConflictError('Only proposals that add to an empty field are accepted together.', { reason: 'BULK_INELIGIBLE', proposalIds: props.map((p) => p.id).sort() });
            const changed = await writeFieldValues(
                db,
                ctx,
                element,
                props.map((p) => ({ key: p.fieldKey!, value: decodeProposedValue(p.proposedValue) })),
            );
            if (changed.length === 0) throw new ValidationError('That would change nothing.', { reason: 'EDIT_CHANGES_NOTHING' });
            await BibleElementRepository.touch(db, ctx.workspaceId, bookId, elementId);
            const answerIds = [...new Set(props.flatMap(citationIds))];
            const version = await recordVersion(db, ctx, bookId, elementId, { source: 'INTERVIEW', sourceAnswerIds: answerIds });
            for (const p of props) {
                await decideOrConflict(db, ctx, p.id, { status: 'ACCEPTED', decidedById: ctx.userId, versionId: version.id });
                await supersedeOthers(db, ctx, elementId, p.fieldKey!, p.id);
                results.push({ proposalId: p.id, status: 'ACCEPTED', elementId, versionNumber: version.versionNumber });
            }
            await logEvent(
                ctx,
                {
                    action: 'ENRICHMENT_PROPOSAL_ACCEPTED',
                    entityType: 'BibleElement',
                    entityId: elementId,
                    details: { bookId, sessionId, bulk: true, proposals: props.length, versionNumber: version.versionNumber, citedAnswerCount: answerIds.length },
                },
                { db },
            );
        }
        return results;
    });
}
