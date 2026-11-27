/**
 * Reviewing research proposals (Phase 2.6): accept, edit then accept, or
 * reject one, and keep a finding as a research note. RULE 1 LIVES HERE: no
 * research output changes the bible until the author accepts it, and every
 * accepted change is ONE new version with source RESEARCH naming the proposal
 * and the findings it cites (`sourceResearchProposalId`, `sourceFindingIds`;
 * the CHECK `BibleEntryVersion_research_names_findings`).
 *
 * The rules are 2.5's (`enrichment-review.ts`), on research's tables:
 *
 *   accept (ADD / UPDATE)  under the element's lock: the request's
 *                          `baseVersion` must be the element's latest (409
 *                          VERSION_CONFLICT); an element that moved since the
 *                          proposal was made needs `reviewedCurrent` (409
 *                          PROPOSAL_OUTDATED); the operation must still fit
 *                          (409 PROPOSAL_STALE). The value through the bible's
 *                          own versioned save. Other PENDING research proposals
 *                          for the field are SUPERSEDED.
 *   accept (NEW_ELEMENT)   the 1.1 create path (`createElementInTx`); refused
 *                          409 ELEMENT_EXISTS when the book holds the name
 *                          (2.5's `bookHoldsElementName`).
 *   edit then accept       the author's value through `normaliseFieldValue`
 *                          (a new element's name and summary through
 *                          `requiredLine` / `optionalBlock`); EDITED_ACCEPTED.
 *   accept (SCENE_NOTE)    Phase 5.1: the note appended to the scene's NOTE as
 *                          a paragraph (`appendResearchNoteInTx`, the one note
 *                          writer: one SceneNoteVersion, RESEARCH, naming the
 *                          proposal and its findings) — never to the scene's
 *                          text (D3; this module never imports the text writer).
 *                          A scene gone is 409 PROPOSAL_STALE, a full note 409
 *                          NOTE_FULL; an edit is plain text (EDITED_ACCEPTED).
 *   reject                 REJECTED; nothing written to the bible.
 *   keep a finding         a NEW research note (a RESEARCH element) holding
 *                          the claim, the summary and the citations, its first
 *                          version RESEARCH naming the finding; once per finding.
 *
 * A proposal flagged POSSIBLE_INSTRUCTION (D14) is accepted only one by one;
 * there is no bulk acceptance of research. Permissions: `bible.edit` decides.
 *
 * THIS MODULE IS ON THE BIBLE'S WRITE PATH: no dial, pack or model import.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository, BibleVersionRepository } from '@/app-layer/repositories/bible.repository';
import { ResearchFindingRepository, ResearchProposalRepository, ResearchRunRepository, type ResearchProposalRow } from '@/app-layer/repositories/research.repository';
import { AcceptResearchInput, KeepFindingInput, ResearchIdParam } from '@/app-layer/schemas/research';
import { CHANGE_SUMMARY_MAX, ELEMENT_NAME_MAX, ELEMENT_SUMMARY_MAX } from '@/app-layer/schemas/bible';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { sameFieldValue, type FieldValue } from '@/lib/bible/field-values';
import { plainBlock, plainLine } from '@/lib/bible/text';
import { getFieldDef } from '@/lib/bible/templates';
import { paragraphsToHtml } from '@/lib/enrichment/validate';
import { decodeResearchValue } from '@/lib/research/storage';
import type { ProposalStatus } from '@/lib/enrichment/vocabulary';
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
import { appendResearchNoteInTx } from './manuscript-notes';

export interface ResearchDecisionResult {
    proposalId: string;
    status: ProposalStatus;
    elementId: string | null;
    versionNumber: number | null;
}

const isEmpty = (v: FieldValue | null): boolean => v === null || (Array.isArray(v) && v.length === 0) || v === '';
const findingIdsOf = (p: ResearchProposalRow) => p.findings.map((f) => f.findingId);

async function requirePending(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, proposalId: string): Promise<ResearchProposalRow> {
    await requireBook(db, ctx, bookId);
    const p = await ResearchProposalRepository.find(db, ctx.workspaceId, ResearchIdParam.parse(proposalId));
    if (!p || p.bookId !== bookId) throw new NotFoundError('Proposal not found.');
    if (p.status !== 'PENDING') throw new ConflictError('This proposal has already been decided.', { reason: 'PROPOSAL_DECIDED', status: p.status });
    return p;
}

async function decideOrConflict(db: PrismaTx, ctx: WorkspaceRequestContext, proposalId: string, data: Parameters<typeof ResearchProposalRepository.decide>[3]): Promise<void> {
    if (!(await ResearchProposalRepository.decide(db, ctx.workspaceId, proposalId, data))) {
        throw new ConflictError('This proposal has already been decided.', { reason: 'PROPOSAL_DECIDED' });
    }
}

async function acceptField(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, proposalId: string, input: AcceptResearchInput): Promise<ResearchDecisionResult> {
    const peek = await ResearchProposalRepository.find(db, ctx.workspaceId, ResearchIdParam.parse(proposalId));
    if (!peek || peek.bookId !== bookId || !peek.elementId) throw new NotFoundError('Proposal not found.');
    await BibleElementRepository.lock(db, peek.elementId);
    const p = await requirePending(db, ctx, bookId, proposalId);
    const element = await requireElement(db, ctx, bookId, p.elementId!);
    if (input.baseVersion === undefined) throw new ValidationError('An acceptance names the version it was reviewed against.', { reason: 'BASE_VERSION_REQUIRED' });
    const currentVersion = await BibleVersionRepository.latestNumber(db, ctx.workspaceId, element.id);
    if (currentVersion !== input.baseVersion) {
        throw new ConflictError('This element was saved by someone else since your review began.', { reason: 'VERSION_CONFLICT', currentVersion, baseVersion: input.baseVersion });
    }
    if (p.baseVersion !== currentVersion && !input.reviewedCurrent) {
        throw new ConflictError('The element changed since this was proposed; review its current value first.', { reason: 'PROPOSAL_OUTDATED', currentVersion, proposedAgainst: p.baseVersion });
    }
    const key = p.fieldKey!;
    const current = (await readFieldValues(db, ctx, element.id)).get(key) ?? null;
    const fits = p.operation === 'ADD' ? isEmpty(current) : !isEmpty(current);
    if (!fits) throw new ConflictError('The field no longer holds what this proposal was made for.', { reason: 'PROPOSAL_STALE', operation: p.operation });
    const proposed = decodeResearchValue(p.proposedValue);
    let value: FieldValue | null = proposed;
    let edited = false;
    if (input.value !== undefined) {
        const next = normaliseFieldEntries(element.kind, [{ key, value: input.value }]).get(key) ?? null;
        if (next === null) throw new ValidationError('An edit cannot empty the field; reject the proposal instead.', { reason: 'EDIT_NOT_ALLOWED' });
        edited = !sameFieldValue(next, proposed);
        value = next;
    }
    const changed = await writeFieldValues(db, ctx, element, [{ key, value }]);
    if (changed.length === 0) throw new ValidationError('That would change nothing.', { reason: 'EDIT_CHANGES_NOTHING' });
    await BibleElementRepository.touch(db, ctx.workspaceId, bookId, element.id);
    const findingIds = findingIdsOf(p);
    const version = await recordVersion(db, ctx, bookId, element.id, {
        source: 'RESEARCH',
        changeSummary: optionalBlock(input.changeSummary, CHANGE_SUMMARY_MAX, 'Change summary') ?? null,
        sourceFindingIds: findingIds,
        sourceResearchProposalId: p.id,
    });
    const status: ProposalStatus = edited ? 'EDITED_ACCEPTED' : 'ACCEPTED';
    await decideOrConflict(db, ctx, p.id, { status, decidedById: ctx.userId, versionId: version.id });
    const others = await ResearchProposalRepository.pendingForField(db, ctx.workspaceId, element.id, key, p.id, 100);
    for (const o of others) await ResearchProposalRepository.decide(db, ctx.workspaceId, o.id, { status: 'SUPERSEDED', decidedById: ctx.userId });
    await logEvent(
        ctx,
        {
            action: 'RESEARCH_PROPOSAL_ACCEPTED',
            entityType: 'ResearchProposal',
            entityId: p.id,
            details: { bookId, runId: p.runId, elementId: element.id, fieldKey: key, operation: p.operation, edited, versionNumber: version.versionNumber, citedFindingCount: findingIds.length, superseded: others.length },
        },
        { db },
    );
    return { proposalId: p.id, status, elementId: element.id, versionNumber: version.versionNumber };
}

async function acceptNewElement(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, proposalId: string, input: AcceptResearchInput): Promise<ResearchDecisionResult> {
    const p = await requirePending(db, ctx, bookId, proposalId);
    if (input.value !== undefined) throw new ValidationError('A new element takes a name and a summary, not a value.', { reason: 'EDIT_NOT_ALLOWED' });
    const name = requiredLine(input.name ?? p.newName ?? '', ELEMENT_NAME_MAX, 'Name');
    const summary = input.summary !== undefined ? (optionalBlock(input.summary, ELEMENT_SUMMARY_MAX, 'Summary') ?? null) : (optionalBlock(p.newSummary, ELEMENT_SUMMARY_MAX, 'Summary') ?? null);
    if (await bookHoldsElementName(db, ctx, bookId, name)) throw new ConflictError('The book already has an element of that name.', { reason: 'ELEMENT_EXISTS' });
    const findingIds = findingIdsOf(p);
    const { element, version } = await createElementInTx(
        db,
        ctx,
        bookId,
        { kind: p.newKind!, name, summary, customLabel: null, fields: [] },
        { source: 'RESEARCH', changeSummary: optionalBlock(input.changeSummary, CHANGE_SUMMARY_MAX, 'Change summary') ?? null, sourceFindingIds: findingIds, sourceResearchProposalId: p.id },
    );
    const status: ProposalStatus = name !== p.newName || summary !== p.newSummary ? 'EDITED_ACCEPTED' : 'ACCEPTED';
    await decideOrConflict(db, ctx, p.id, { status, decidedById: ctx.userId, createdElementId: element.id });
    await logEvent(
        ctx,
        { action: 'RESEARCH_PROPOSAL_ACCEPTED', entityType: 'ResearchProposal', entityId: p.id, details: { bookId, runId: p.runId, elementId: element.id, kind: p.newKind, newElement: true, versionNumber: version.versionNumber, citedFindingCount: findingIds.length } },
        { db },
    );
    return { proposalId: p.id, status, elementId: element.id, versionNumber: version.versionNumber };
}

async function acceptSceneNote(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, proposalId: string, input: AcceptResearchInput): Promise<ResearchDecisionResult> {
    const p = await requirePending(db, ctx, bookId, proposalId);
    if (!p.sceneId) throw new NotFoundError('Proposal not found.');
    const proposed = decodeResearchValue(p.proposedValue);
    if (typeof proposed !== 'string') throw new ConflictError('This proposal cannot be read.', { reason: 'PROPOSAL_STALE' });
    let text = proposed;
    if (input.value !== undefined) {
        if (typeof input.value !== 'string') throw new ValidationError('A scene note is text.', { reason: 'EDIT_NOT_ALLOWED' });
        const edited = plainBlock(input.value);
        if (!edited) throw new ValidationError('An edit cannot empty the note; reject the proposal instead.', { reason: 'EDIT_NOT_ALLOWED' });
        text = edited;
    }
    const findingIds = findingIdsOf(p);
    const result = await appendResearchNoteInTx(db, ctx, bookId, p.sceneId, text, { proposalId: p.id, findingIds });
    if (!result.versionId) throw new ValidationError('That would change nothing.', { reason: 'EDIT_CHANGES_NOTHING' });
    const status: ProposalStatus = text !== proposed ? 'EDITED_ACCEPTED' : 'ACCEPTED';
    await decideOrConflict(db, ctx, p.id, { status, decidedById: ctx.userId, versionId: result.versionId });
    await logEvent(
        ctx,
        {
            action: 'RESEARCH_PROPOSAL_ACCEPTED',
            entityType: 'ResearchProposal',
            entityId: p.id,
            details: { bookId, runId: p.runId, sceneId: p.sceneId, operation: 'SCENE_NOTE', edited: status === 'EDITED_ACCEPTED', noteVersion: result.noteVersion, citedFindingCount: findingIds.length },
        },
        { db },
    );
    return { proposalId: p.id, status, elementId: null, versionNumber: result.noteVersion };
}

/** Retry a create that lost a derived slug to a concurrent one, in a fresh transaction (as `createElement` does). */
async function withSlugRetry<T>(ctx: WorkspaceRequestContext, work: (db: PrismaTx) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await runInWorkspaceContext(ctx, work);
        } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            if (attempt >= DERIVED_SLUG_ATTEMPTS) throw slugConflict();
        }
    }
}

/** Accept one research proposal, as proposed or edited (`bible.edit`). */
export async function acceptResearchProposal(ctx: WorkspaceRequestContext, bookId: string, proposalId: string, input: unknown): Promise<ResearchDecisionResult> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = AcceptResearchInput.parse(input ?? {});
    const op = await runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const p = await ResearchProposalRepository.find(db, ctx.workspaceId, ResearchIdParam.parse(proposalId));
        return p && p.bookId === bookId ? p.operation : null;
    });
    if (op === null) throw new NotFoundError('Proposal not found.');
    if (op === 'NEW_ELEMENT') return withSlugRetry(ctx, (db) => acceptNewElement(db, ctx, bookId, proposalId, parsed));
    if (op === 'SCENE_NOTE') return runInWorkspaceContext(ctx, (db) => acceptSceneNote(db, ctx, bookId, proposalId, parsed));
    return runInWorkspaceContext(ctx, (db) => acceptField(db, ctx, bookId, proposalId, parsed));
}

/** Reject one research proposal: nothing is written to the bible (`bible.edit`). */
export async function rejectResearchProposal(ctx: WorkspaceRequestContext, bookId: string, proposalId: string): Promise<ResearchDecisionResult> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        const p = await requirePending(db, ctx, bookId, proposalId);
        await decideOrConflict(db, ctx, p.id, { status: 'REJECTED', decidedById: ctx.userId });
        await logEvent(ctx, { action: 'RESEARCH_PROPOSAL_REJECTED', entityType: 'ResearchProposal', entityId: p.id, details: { bookId, runId: p.runId, operation: p.operation, fieldKey: p.fieldKey } }, { db });
        return { proposalId: p.id, status: 'REJECTED' as const, elementId: p.elementId, versionNumber: null };
    });
}

/** A research note's list item: at most the field's item bound. */
function item(text: string, max = 500): string {
    const t = plainLine(text);
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Keep a finding as a new research note (`bible.edit`): its claim, summary and citations, once. */
export async function keepFindingAsNote(ctx: WorkspaceRequestContext, bookId: string, runId: string, findingId: string, input: unknown): Promise<{ elementId: string; versionNumber: number }> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = KeepFindingInput.parse(input ?? {});
    return withSlugRetry(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const run = await ResearchRunRepository.find(db, ctx.workspaceId, ResearchIdParam.parse(runId));
        if (!run || run.bookId !== bookId) throw new NotFoundError('Finding not found.');
        const f = await ResearchFindingRepository.find(db, ctx.workspaceId, run.id, ResearchIdParam.parse(findingId));
        if (!f) throw new NotFoundError('Finding not found.');
        if (f.keptElementId) throw new ConflictError('This finding is already kept as a research note.', { reason: 'FINDING_KEPT', elementId: f.keptElementId });
        const name = requiredLine(parsed.name ?? item(f.claim, ELEMENT_NAME_MAX), ELEMENT_NAME_MAX, 'Name');
        if (await bookHoldsElementName(db, ctx, bookId, name)) throw new ConflictError('The book already has an element of that name.', { reason: 'ELEMENT_EXISTS' });
        const sources = f.citations.map((c) => item([c.title, c.url].filter((x): x is string => !!x).join(' — ') || 'Attached file'));
        const fields = [
            { key: 'topic', value: item(f.claim, 300) },
            { key: 'established_facts', value: [item(`${f.claim} (${sources.join('; ')})`)] },
            { key: 'sources', value: sources },
            { key: 'notes', value: paragraphsToHtml(plainBlock(f.summary)) },
        ].filter((e) => getFieldDef('RESEARCH', e.key));
        const { element, version } = await createElementInTx(
            db,
            ctx,
            bookId,
            { kind: 'RESEARCH', name, summary: null, customLabel: null, fields },
            { source: 'RESEARCH', sourceFindingIds: [f.id] },
        );
        const marked = await ResearchFindingRepository.markKept(db, ctx.workspaceId, f.id, element.id);
        if (marked.count !== 1) throw new ConflictError('This finding is already kept as a research note.', { reason: 'FINDING_KEPT' });
        await logEvent(ctx, { action: 'RESEARCH_FINDING_KEPT', entityType: 'ResearchFinding', entityId: f.id, details: { bookId, runId: run.id, elementId: element.id, citationCount: f.citations.length } }, { db });
        return { elementId: element.id, versionNumber: version.versionNumber };
    });
}
