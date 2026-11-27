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
 *
 * PHASE 3.3 (decision D24). A RELATION_FIELD proposal is accepted as a FIELD
 * one is, through the RELATION's versioned save (`relation-common.ts`: its
 * lock, its `baseVersion`, one `BibleRelationVersion` INTERVIEW naming the
 * answers). A NEW_RELATION proposal creates the relation through the one
 * create path (`createRelationInTx`: the 1.1 rules, the symmetric pair index;
 * a relation the book now holds is 409 RELATION_EXISTS), its first version
 * INTERVIEW naming the answers — so the relation's creation is attributable to
 * them. An end that is a NEW_ELEMENT proposal of the session is accepted
 * FIRST: until it is, accepting the relation is 409 END_NOT_CREATED, and once
 * it is rejected (or what it created is gone) 409 END_GONE. A NEW_ELEMENT that
 * fills a BETWEEN slot is created with its first fields and the slot's act,
 * then placed between the slot's neighbours by the order move
 * (`placeNewElementInOrderTx`), under the names lock and then the order's lock,
 * both before any element lock (the book's lock order, as the bundle import
 * takes them). Phase 3.H (D25, "refuse and ask"): only while the slot still
 * stands (`slotChangeOf`); a changed slot is 409 SLOT_CHANGED, writing
 * nothing, until the author names a `placement` — two neighbours, or
 * `{ unplaced: true }`. An accepted relation names its two ends
 * (`relationEnds`). Phase 3.H (D25 as the owner amended it): a FIELD proposal
 * may name the slot's beat by its proposal (`targetProposalId`) instead of an
 * element: a further field of the beat a later round of the session asked
 * about. It is accepted only once the beat is (409 END_NOT_CREATED; a rejected
 * beat or a deleted element 409 END_GONE), into the element the beat's
 * acceptance created, under that element's lock and version like any FIELD
 * proposal, with only "the field is still empty" to hold it (it was proposed
 * against no version); never in bulk.
 * Neither new kind is offered for bulk acceptance or edited on acceptance: a
 * link is accepted as proposed or rejected, and its fields edited afterwards.
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
import {
    BibleElementRepository,
    BibleFieldRepository,
    BibleRelationFieldRepository,
    BibleRelationRepository,
    BibleRelationVersionRepository,
    BibleVersionRepository,
} from '@/app-layer/repositories/bible.repository';
import { EnrichmentAnswerReads, EnrichmentProposalRepository, ReconcileRunRepository, type ProposalRow } from '@/app-layer/repositories/enrichment.repository';
import { InterviewRoundRepository, InterviewSessionRepository } from '@/app-layer/repositories/interview.repository';
import { AcceptProposalInput, BulkAcceptInput, ProposalIdParam } from '@/app-layer/schemas/enrichment';
import { CHANGE_SUMMARY_MAX, ELEMENT_NAME_MAX, ELEMENT_SUMMARY_MAX } from '@/app-layer/schemas/bible';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { decodeFieldValue, sameFieldValue, type FieldValue } from '@/lib/bible/field-values';
import type { FieldDef, RelationFieldDef } from '@/lib/bible/template-schema';
import { getFieldDef, getRelationFieldDef, getRelationType } from '@/lib/bible/templates';
import { decodeNewElementFields, decodeNewRelation, decodeProposedValue } from '@/lib/enrichment/storage';
import { bulkEligible, opFits } from '@/lib/enrichment/review-rules';
import { effectiveRunState, PROPOSAL_FLAGS, type ProposalFlag, type ProposalStatus, type ReconcileOutcome, type StoredOp } from '@/lib/enrichment/vocabulary';
import {
    DERIVED_SLUG_ATTEMPTS,
    isForeignKeyViolation,
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
import { acceptSceneCardFieldInTx } from './scene-card';
import { SceneCardRepository } from '@/app-layer/repositories/scene-card.repository';
import { SCENE_CARD_FIELDS, isSceneCardField, type SceneCardFieldKey } from '@/lib/manuscript/scene-card';
import { ACT_FIELD_KEY, placeNewElementInOrderTx, reserveOrderPlaceTx } from './bible-order';
import { createRelationInTx, relationExists, relationGoneAsNotFound } from './bible-relations';
import { bookHoldsElementName } from './enrichment-names';
import { slotChangeOf, slotLaneChoices, type SlotChange } from './story-slot';
import { assertRelationBaseVersion, normaliseRelationFieldEntries, readRelationFieldValues, recordRelationVersion, relationForSave, requireRelationWithEnds, writeRelationFieldValues } from './relation-common';

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
    /** Phase 4.3 (D29): the persona whose question it answered (the review groups a panel's answers by who asked), or null. */
    personaKey: string | null;
}

export interface FieldProposalView {
    id: string;
    kind: 'FIELD';
    roundNumber: number | null;
    status: ProposalStatus;
    /** The element it changes; null for a slot beat's field whose beat is not (or no longer) an element. */
    elementId: string | null;
    elementName: string;
    elementKind: BibleElementKind;
    /**
     * Phase 3.H (D25 as amended): a further field of the BETWEEN slot's beat an
     * earlier round proposed, by that beat's proposal. `state`: the beat is
     * still to decide (accept it first: END_NOT_CREATED), an element now
     * (`elementId`), or rejected or deleted (END_GONE). Null for any other field.
     */
    slotBeat: { proposalId: string; name: string; state: 'PENDING' | 'CREATED' | 'GONE' } | null;
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
    /** Phase 3.3: its first field values with their template fields, in template order. */
    fields: Array<{ field: FieldDef; value: FieldValue }>;
    /** Phase 3.3: it fills a BETWEEN slot, placed between these two when accepted. */
    slot: SlotView | null;
}

/**
 * A slot as the review shows it (Phase 3.3; 3.H). `changed` names how it
 * changed since the session started (a neighbour deleted, unplaced or moved,
 * or a beat now between them): accepting the beat as proposed is then refused
 * 409 SLOT_CHANGED, and the author chooses where it goes among `choices` (the
 * placed beats of the slot's act, in story order) or accepts it unplaced
 * (decision D25). A neighbour's name is null once it is deleted.
 */
export interface SlotView {
    afterElementId: string;
    afterName: string | null;
    beforeElementId: string;
    beforeName: string | null;
    act: string | null;
    changed: SlotChange | null;
    choices: Array<{ elementId: string; name: string }>;
    choicesTruncated: boolean;
}

/** Phase 3.3 (D24): a change to one field of a relation. */
export interface RelationFieldProposalView {
    id: string;
    kind: 'RELATION_FIELD';
    roundNumber: number | null;
    status: ProposalStatus;
    relationId: string;
    /** The relation as the author reads it: its ends and its type's label. */
    relation: { type: string; label: string; from: { id: string; name: string; kind: BibleElementKind }; to: { id: string; name: string; kind: BibleElementKind } };
    fieldKey: string;
    field: RelationFieldDef;
    operation: StoredOp;
    proposedValue: FieldValue | null;
    currentValue: FieldValue | null;
    baseVersion: number;
    currentVersion: number;
    flags: ProposalFlag[];
    citedAnswerIds: string[];
    decidedAt: string | null;
}

/** Phase 5.3 (D35): a change to one field of a scene's CARD ("Grill me on this scene"; never the scene's prose, D3). */
export interface SceneCardFieldProposalView {
    id: string;
    kind: 'SCENE_CARD_FIELD';
    roundNumber: number | null;
    status: ProposalStatus;
    sceneId: string;
    sceneTitle: string | null;
    fieldKey: SceneCardFieldKey;
    field: FieldDef;
    operation: StoredOp;
    proposedValue: string | null;
    currentValue: string | null;
    baseVersion: number;
    currentVersion: number;
    flags: ProposalFlag[];
    citedAnswerIds: string[];
    decidedAt: string | null;
}

/** An end of a proposed relation: an element of the book, or a new element of the same session (by its proposal). */
export interface NewRelationEndView {
    elementId: string | null;
    proposalId: string | null;
    name: string;
    kind: BibleElementKind | null;
    /** Accepting the relation needs this end: false while a proposed end waits for its own acceptance. */
    exists: boolean;
}

/** Phase 3.3 (D24): a proposed relation between two elements. */
export interface NewRelationProposalView {
    id: string;
    kind: 'NEW_RELATION';
    roundNumber: number | null;
    status: ProposalStatus;
    type: string;
    label: string;
    from: NewRelationEndView;
    to: NewRelationEndView;
    note: string | null;
    fields: Array<{ field: FieldDef; value: FieldValue }>;
    createdRelationId: string | null;
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
    /** Phase 3.3 (D24). */
    relationFields: RelationFieldProposalView[];
    newRelations: NewRelationProposalView[];
    /** Phase 5.3 (D35). */
    sceneCardFields: SceneCardFieldProposalView[];
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

/** A stored proposal's first values with their template fields, in template order (a key the template no longer has is left out). */
function labelledFields(values: ReadonlyMap<string, FieldValue>, defOf: (key: string) => FieldDef | undefined): Array<{ field: FieldDef; value: FieldValue }> {
    return [...values]
        .flatMap(([key, value]) => {
            const field = defOf(key);
            return field ? [{ field, value }] : [];
        })
        .sort((a, b) => a.field.order - b.field.order);
}

type SessionSlot = { id: string; slotAfterElementId: string | null; slotBeforeElementId: string | null; slotAct: string | null };

/**
 * Views of stored proposals, every kind (the review page, and Phase 3.3's map
 * preview), with the current state of what each targets: an element's field
 * and version, a relation's field and version, a new relation's ends (an
 * element, or a new element proposal and whether it was accepted). A
 * proposal whose target is gone is left out (its row goes with it by cascade).
 */
async function proposalViews(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    proposals: readonly ProposalRow[],
    numberOf: ReadonlyMap<string, number>,
    sessions: ReadonlyMap<string, SessionSlot>,
): Promise<{ fields: FieldProposalView[]; newElements: NewElementProposalView[]; relationFields: RelationFieldProposalView[]; newRelations: NewRelationProposalView[]; sceneCardFields: SceneCardFieldProposalView[] }> {
    const slotIds = [...sessions.values()].flatMap((s) => [s.slotAfterElementId, s.slotBeforeElementId].filter((x): x is string => x !== null));
    // Phase 3.H: the beats a slot beat's field proposals name, read by id when they are not on this page.
    const byId = new Map(proposals.map((p) => [p.id, p] as const));
    const missingBeats = [...new Set(proposals.flatMap((p) => (p.targetProposalId && !byId.has(p.targetProposalId) ? [p.targetProposalId] : [])))];
    for (const p of proposals.length > 0 && missingBeats.length > 0 ? await EnrichmentProposalRepository.listByIds(db, ctx.workspaceId, proposals[0].sessionId, missingBeats) : []) byId.set(p.id, p);
    const beatElementOf = (p: ProposalRow): string | null => (p.targetProposalId ? (byId.get(p.targetProposalId)?.createdElementId ?? null) : null);
    const elementIds = [
        ...new Set([...proposals.flatMap((p) => [p.elementId, p.newFromElementId, p.newToElementId, beatElementOf(p)].filter((x): x is string => x !== null)), ...slotIds]),
    ];
    const elements = new Map((await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, elementIds)).map((e) => [e.id, e] as const));
    const fieldElementIds = [...new Set(proposals.flatMap((p) => (p.elementId ? [p.elementId] : p.targetProposalId && beatElementOf(p) ? [beatElementOf(p)!] : [])))].filter((id) => elements.has(id));
    const values = new Map<string, Map<string, FieldValue>>();
    for (const f of await BibleFieldRepository.listForElements(db, ctx.workspaceId, fieldElementIds, FIELDS_PER_ELEMENT)) {
        if (!values.has(f.elementId)) values.set(f.elementId, new Map());
        values.get(f.elementId)!.set(f.key, decodeFieldValue(f.value));
    }
    const versions = new Map<string, number>();
    for (const id of fieldElementIds) versions.set(id, await BibleVersionRepository.latestNumber(db, ctx.workspaceId, id));

    // Phase 3.3: the relations RELATION_FIELD proposals change, with their fields and versions.
    const relationIds = [...new Set(proposals.flatMap((p) => (p.relationId ? [p.relationId] : [])))];
    const relations = new Map((await BibleRelationRepository.listByIdsWithEnds(db, ctx.workspaceId, bookId, relationIds)).map((r) => [r.id, r] as const));
    const relationValues = new Map<string, Map<string, FieldValue>>();
    for (const f of await BibleRelationFieldRepository.listForRelations(db, ctx.workspaceId, [...relations.keys()], FIELDS_PER_ELEMENT)) {
        if (!relationValues.has(f.relationId)) relationValues.set(f.relationId, new Map());
        relationValues.get(f.relationId)!.set(f.key, decodeFieldValue(f.value));
    }
    const relationVersions = await BibleRelationVersionRepository.latestNumbers(db, ctx.workspaceId, [...relations.keys()]);
    // A new relation's proposed end, when it is not among `proposals` (another page of the review): read by id.
    const missingEnds = [...new Set(proposals.flatMap((p) => [p.newFromProposalId, p.newToProposalId].filter((x): x is string => x !== null && !byId.has(x))))];
    for (const p of proposals.length > 0 && missingEnds.length > 0 ? await EnrichmentProposalRepository.listByIds(db, ctx.workspaceId, proposals[0].sessionId, missingEnds) : []) byId.set(p.id, p);
    const createdIds = [...byId.values()].flatMap((p) => (p.createdElementId ? [p.createdElementId] : []));
    const createdLive = new Set((await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, createdIds)).map((e) => e.id));

    // Phase 5.3: the scenes SCENE_CARD_FIELD proposals change, with their cards (titles and the card's fields).
    const sceneIds = [...new Set(proposals.flatMap((p) => (p.sceneId ? [p.sceneId] : [])))];
    const scenes = new Map((await SceneCardRepository.scenesByIds(db, ctx.workspaceId, bookId, sceneIds)).map((sc) => [sc.id, sc] as const));
    const cards = new Map((await SceneCardRepository.forScenes(db, ctx.workspaceId, bookId, [...scenes.keys()])).map((c) => [c.sceneId, c] as const));

    const out = {
        fields: [] as FieldProposalView[],
        newElements: [] as NewElementProposalView[],
        relationFields: [] as RelationFieldProposalView[],
        newRelations: [] as NewRelationProposalView[],
        sceneCardFields: [] as SceneCardFieldProposalView[],
    };
    for (const p of proposals) {
        const roundNumber = numberOf.get(p.roundId) ?? null;
        const common = { id: p.id, roundNumber, status: p.status, flags: flagsOf(p), citedAnswerIds: citationIds(p), decidedAt: p.decidedAt ? p.decidedAt.toISOString() : null };
        if (p.kind === 'NEW_ELEMENT') {
            const session = sessions.get(p.sessionId);
            let slot: SlotView | null = null;
            if (p.fillsSlot && session?.slotAfterElementId && session.slotBeforeElementId) {
                // Only a beat still to decide is checked against its slot (D25): a decided one was placed, or not, then.
                const changed = p.status === 'PENDING' ? await slotChangeOf(db, ctx, bookId, session) : null;
                const lane = changed ? await slotLaneChoices(db, ctx, bookId, session.slotAct) : { choices: [], truncated: false };
                slot = {
                    afterElementId: session.slotAfterElementId,
                    afterName: elements.get(session.slotAfterElementId)?.name ?? null,
                    beforeElementId: session.slotBeforeElementId,
                    beforeName: elements.get(session.slotBeforeElementId)?.name ?? null,
                    act: session.slotAct,
                    changed,
                    choices: lane.choices,
                    choicesTruncated: lane.truncated,
                };
            }
            out.newElements.push({
                ...common,
                kind: 'NEW_ELEMENT',
                newKind: p.newKind!,
                name: p.newName ?? '',
                summary: p.newSummary,
                createdElementId: p.createdElementId,
                fields: labelledFields(decodeNewElementFields(p.proposedValue), (key) => getFieldDef(p.newKind!, key)),
                slot,
            });
            continue;
        }
        if (p.kind === 'NEW_RELATION') {
            const endOf = (elementId: string | null, proposalId: string | null): NewRelationEndView | null => {
                if (elementId) {
                    const e = elements.get(elementId);
                    return e ? { elementId, proposalId: null, name: e.name, kind: e.kind, exists: true } : null;
                }
                const q = proposalId ? byId.get(proposalId) : undefined;
                if (!q) return null;
                const created = q.createdElementId && createdLive.has(q.createdElementId) ? q.createdElementId : null;
                return { elementId: created, proposalId: q.id, name: q.newName ?? '', kind: q.newKind, exists: created !== null };
            };
            const from = endOf(p.newFromElementId, p.newFromProposalId);
            const to = endOf(p.newToElementId, p.newToProposalId);
            if (!from || !to) continue;
            const fromKind = from.kind;
            const type = fromKind ? getRelationType(fromKind, p.newRelationType!) : undefined;
            const decoded = decodeNewRelation(p.proposedValue);
            out.newRelations.push({
                ...common,
                kind: 'NEW_RELATION',
                type: p.newRelationType!,
                label: type?.label ?? p.newRelationType!,
                from,
                to,
                note: decoded.note,
                fields: labelledFields(decoded.fields, (key) => (fromKind ? getRelationFieldDef(fromKind, p.newRelationType!, key) : undefined)),
                createdRelationId: p.createdRelationId,
            });
            continue;
        }
        if (p.kind === 'SCENE_CARD_FIELD') {
            const scene = scenes.get(p.sceneId!);
            const def = SCENE_CARD_FIELDS.find((f) => f.key === p.fieldKey);
            if (!scene || !def || !isSceneCardField(def.key)) continue;
            const card = cards.get(scene.id);
            const proposed = decodeProposedValue(p.proposedValue);
            out.sceneCardFields.push({
                ...common,
                kind: 'SCENE_CARD_FIELD',
                sceneId: scene.id,
                sceneTitle: scene.title,
                fieldKey: def.key,
                field: def,
                operation: p.operation!,
                proposedValue: typeof proposed === 'string' ? proposed : null,
                currentValue: card?.[def.key] ?? null,
                baseVersion: p.baseVersion!,
                currentVersion: card?.version ?? 0,
            });
            continue;
        }
        if (p.kind === 'RELATION_FIELD') {
            const r = relations.get(p.relationId!);
            const def = r ? getRelationFieldDef(r.from.kind, r.type, p.fieldKey!) : undefined;
            if (!r || !def) continue;
            out.relationFields.push({
                ...common,
                kind: 'RELATION_FIELD',
                relationId: r.id,
                relation: {
                    type: r.type,
                    label: getRelationType(r.from.kind, r.type)?.label ?? r.type,
                    from: { id: r.from.id, name: r.from.name, kind: r.from.kind },
                    to: { id: r.to.id, name: r.to.name, kind: r.to.kind },
                },
                fieldKey: def.key,
                field: def,
                operation: p.operation!,
                proposedValue: decodeProposedValue(p.proposedValue),
                currentValue: relationValues.get(r.id)?.get(def.key) ?? null,
                baseVersion: p.baseVersion!,
                currentVersion: relationVersions.get(r.id) ?? 0,
            });
            continue;
        }
        if (p.targetProposalId) {
            // A further field of a slot's beat (Phase 3.H): shown against the beat, and against its element once created.
            const beat = byId.get(p.targetProposalId);
            const def = beat?.newKind ? getFieldDef(beat.newKind, p.fieldKey!) : undefined;
            if (!beat || !def) continue;
            const made = beat.createdElementId ? (elements.get(beat.createdElementId) ?? null) : null;
            const gone = beat.status === 'REJECTED' || beat.status === 'SUPERSEDED' || (beat.createdElementId !== null && made === null);
            const currentVersion = made ? (versions.get(made.id) ?? 0) : 0;
            out.fields.push({
                ...common,
                kind: 'FIELD',
                elementId: made?.id ?? null,
                elementName: made?.name ?? beat.newName ?? '',
                elementKind: beat.newKind!,
                slotBeat: { proposalId: beat.id, name: made?.name ?? beat.newName ?? '', state: made ? 'CREATED' : gone ? 'GONE' : 'PENDING' },
                fieldKey: def.key,
                field: def,
                operation: p.operation!,
                proposedValue: decodeProposedValue(p.proposedValue),
                currentValue: made ? (values.get(made.id)?.get(def.key) ?? null) : null,
                // Proposed before its element existed: reviewed against the element as it is now.
                baseVersion: currentVersion,
                currentVersion,
                bulkEligible: false,
            });
            continue;
        }
        const element = elements.get(p.elementId!);
        const def = element ? getFieldDef(element.kind, p.fieldKey!) : undefined;
        if (!element || !def) continue;
        const current = values.get(element.id)?.get(def.key) ?? null;
        out.fields.push({
            ...common,
            kind: 'FIELD',
            elementId: element.id,
            elementName: element.name,
            elementKind: element.kind,
            slotBeat: null,
            fieldKey: def.key,
            field: def,
            operation: p.operation!,
            proposedValue: decodeProposedValue(p.proposedValue),
            currentValue: current,
            baseVersion: p.baseVersion!,
            currentVersion: versions.get(element.id) ?? 0,
            bulkEligible: bulkEligible({ status: p.status, operation: p.operation!, flags: p.flags }, current),
        });
    }
    return out;
}

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

        const views = await proposalViews(db, ctx, bookId, proposals, numberOf, new Map([[session.id, session]]));
        const cited = [...new Set(proposals.flatMap(citationIds))];
        const answers: Record<string, CitedAnswerView> = {};
        for (const a of await EnrichmentAnswerReads.listCited(db, ctx.workspaceId, sessionId, cited)) {
            answers[a.id] = { answerId: a.id, question: a.question.text, questionKind: a.question.kind, answer: answerText(a), status: a.status, personaKey: a.question.personaKey };
        }
        const runs = (await ReconcileRunRepository.listForSession(db, ctx.workspaceId, sessionId, REVIEW_ROUNDS_READ)).map((r) => {
            const m = (r.metrics ?? {}) as { reviewRequired?: boolean; refusalReason?: string };
            const state = effectiveRunState(r);
            return { roundNumber: numberOf.get(r.roundId) ?? null, status: state.status, outcome: state.outcome, reviewRequired: m.reviewRequired ?? false, refusalReason: m.refusalReason ?? null };
        });
        return {
            session: { id: session.id, bookId, scope: session.scope, targetElementId: session.targetElementId, targetKind: session.targetKind, status: session.status },
            ...views,
            answers,
            runs,
            truncated: rows.length > REVIEW_PROPOSALS_MAX,
        };
    });
}

/** The book's pending structural proposals a story map previews, at most (one more is read to say it was cut). */
export const PENDING_STRUCTURE_MAX = 200;

/** Phase 3.3: a structural proposal as a story map previews and lists it, with the session it belongs to (its review page). */
export type PendingStructureView =
    | (NewElementProposalView & { sessionId: string })
    | (NewRelationProposalView & { sessionId: string });

/**
 * The book's PENDING new elements and new relations (Phase 3.3, `bible.view`):
 * what a story map shows as ghost nodes and edges, and lists beside them as
 * the record — each with the answers it cites, so the list stands on its own
 * whether or not the canvas draws. Accepting or rejecting goes through the
 * session's ordinary review routes.
 */
export async function listPendingStructure(
    ctx: WorkspaceRequestContext,
    bookId: string,
): Promise<{ proposals: PendingStructureView[]; answers: Record<string, CitedAnswerView>; truncated: boolean }> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const rows = await EnrichmentProposalRepository.pendingStructuralForBook(db, ctx.workspaceId, bookId, PENDING_STRUCTURE_MAX + 1);
        const pending = rows.slice(0, PENDING_STRUCTURE_MAX);
        const out: PendingStructureView[] = [];
        const answers: Record<string, CitedAnswerView> = {};
        // Grouped by session: a review's reads are per session (its rounds, its proposals' ends, its answers).
        const bySession = new Map<string, ProposalRow[]>();
        for (const p of pending) bySession.set(p.sessionId, [...(bySession.get(p.sessionId) ?? []), p]);
        for (const [sessionId, proposals] of bySession) {
            const session = await InterviewSessionRepository.find(db, ctx.workspaceId, bookId, sessionId);
            if (!session) continue;
            const rounds = await InterviewRoundRepository.listForSession(db, ctx.workspaceId, sessionId, REVIEW_ROUNDS_READ);
            const views = await proposalViews(db, ctx, bookId, proposals, new Map(rounds.map((r) => [r.id, r.number] as const)), new Map([[session.id, session]]));
            for (const v of views.newElements) out.push({ ...v, sessionId });
            for (const v of views.newRelations) out.push({ ...v, sessionId });
            for (const a of await EnrichmentAnswerReads.listCited(db, ctx.workspaceId, sessionId, [...new Set(proposals.flatMap(citationIds))])) {
                answers[a.id] = { answerId: a.id, question: a.question.text, questionKind: a.question.kind, answer: answerText(a), status: a.status, personaKey: a.question.personaKey };
            }
        }
        return { proposals: out, answers, truncated: rows.length > PENDING_STRUCTURE_MAX };
    });
}

/**
 * The rounds of a session whose reconcile run did not run to its end — FAILED
 * (or past its claim, `CLAIM_EXPIRED`) or REFUSED — by number, ascending
 * (`bible.view`; nothing decrypted). The interview page names them so the
 * author knows their answers are waiting (issue #39 item 6); the review page
 * re-runs them.
 */
/** A round whose reconcile did not run to its end, and its outcome (the page words a TOKEN_BUDGET refusal apart: running it again cannot help). */
export interface ReconcileAttention {
    roundNumber: number;
    outcome: string | null;
}

export async function reconcileRoundsNeedingAttention(ctx: WorkspaceRequestContext, bookId: string, sessionId: string): Promise<ReconcileAttention[]> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const rounds = await InterviewRoundRepository.listForSession(db, ctx.workspaceId, sessionId, REVIEW_ROUNDS_READ);
        const numberOf = new Map(rounds.map((r) => [r.id, r.number] as const));
        const out = new Map<number, string | null>();
        for (const r of await ReconcileRunRepository.listForSession(db, ctx.workspaceId, sessionId, REVIEW_ROUNDS_READ)) {
            const state = effectiveRunState(r);
            const n = numberOf.get(r.roundId);
            if (n !== undefined && (state.status === 'FAILED' || state.status === 'REFUSED')) out.set(n, state.outcome ?? null);
        }
        return [...out.entries()].sort(([a], [b]) => a - b).map(([roundNumber, outcome]) => ({ roundNumber, outcome }));
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
    /** Phase 3.3: the relation an acceptance changed or created. */
    relationId?: string | null;
    /** Phase 3.3: a slot's new element was placed (false: accepted unplaced, as the author chose; D25). */
    placed?: boolean;
    /** Phase 3.H: a created relation's two ends, so a view whose copy of an end is stale can still draw the edge. */
    relationEnds?: { fromElementId: string; toElementId: string };
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

/**
 * The element a FIELD proposal for a slot's beat writes to (Phase 3.H, D25 as
 * amended): the one the beat's acceptance created. The beat still PENDING is
 * 409 END_NOT_CREATED; rejected (or superseded), or its element deleted since,
 * 409 END_GONE — as a new relation's end that is a new element.
 */
async function slotBeatElementOf(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sessionId: string, targetProposalId: string): Promise<string> {
    const [beat] = await EnrichmentProposalRepository.listEnds(db, ctx.workspaceId, sessionId, [targetProposalId]);
    if (!beat || beat.status === 'REJECTED' || beat.status === 'SUPERSEDED') throw new ConflictError('The new entry this field belongs to was not created.', { reason: 'END_GONE' });
    if (beat.status === 'PENDING' || !beat.createdElementId) throw new ConflictError('Accept the new entry this field belongs to first.', { reason: 'END_NOT_CREATED', proposalId: beat.id });
    if (!(await BibleElementRepository.find(db, ctx.workspaceId, bookId, beat.createdElementId))) throw new ConflictError('The new entry this field belongs to has been deleted.', { reason: 'END_GONE' });
    return beat.createdElementId;
}

async function acceptField(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sessionId: string, proposalId: string, input: AcceptProposalInput): Promise<DecisionResult> {
    const peek = await EnrichmentProposalRepository.find(db, ctx.workspaceId, sessionId, ProposalIdParam.parse(proposalId));
    if (!peek || peek.bookId !== bookId) throw new NotFoundError('Proposal not found.');
    if (peek.kind !== 'FIELD') throw new ValidationError('This proposal is for a new element.', { reason: 'EDIT_NOT_ALLOWED' });
    // A field of a slot's beat (Phase 3.H) goes to the element the beat's acceptance created, once it has one.
    const elementId = peek.targetProposalId ? await slotBeatElementOf(db, ctx, bookId, sessionId, peek.targetProposalId) : peek.elementId!;
    // The element's lock first, then the proposal read under it (a concurrent save of the element queues).
    await BibleElementRepository.lock(db, elementId);
    const p = await requirePending(db, ctx, bookId, sessionId, proposalId);
    // A slot beat's element deleted while this waited for its lock is gone as the beat's field sees it (END_GONE), not a 404.
    const element = await requireElement(db, ctx, bookId, elementId).catch((err: unknown) => {
        if (p.targetProposalId && err instanceof NotFoundError) throw new ConflictError('The new entry this field belongs to has been deleted.', { reason: 'END_GONE' });
        throw err;
    });
    if (input.baseVersion === undefined) throw new ValidationError('An acceptance names the version it was reviewed against.', { reason: 'BASE_VERSION_REQUIRED' });
    const currentVersion = await BibleVersionRepository.latestNumber(db, ctx.workspaceId, element.id);
    if (currentVersion !== input.baseVersion) {
        throw new ConflictError('This element was saved by someone else since your review began.', { reason: 'VERSION_CONFLICT', currentVersion, baseVersion: input.baseVersion });
    }
    // A slot beat's field was proposed before its element existed (no base): only "the field is still empty" holds it.
    if (p.baseVersion !== null && p.baseVersion !== currentVersion && !input.reviewedCurrent) {
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
    let superseded = await supersedeOthers(db, ctx, element.id, key, p.id);
    if (p.targetProposalId) {
        const others = await EnrichmentProposalRepository.pendingForSlotBeatField(db, ctx.workspaceId, p.targetProposalId, key, p.id, 100);
        for (const o of others) await EnrichmentProposalRepository.decide(db, ctx.workspaceId, o.id, { status: 'SUPERSEDED', decidedById: ctx.userId });
        superseded += others.length;
    }
    await logEvent(
        ctx,
        {
            action: 'ENRICHMENT_PROPOSAL_ACCEPTED',
            entityType: 'EnrichmentProposal',
            entityId: p.id,
            details: {
                bookId,
                sessionId,
                elementId: element.id,
                fieldKey: key,
                operation: op,
                edited,
                flags: p.flags,
                versionNumber: version.versionNumber,
                citedAnswerCount: answerIds.length,
                superseded,
                ...(p.targetProposalId ? { slotBeatProposalId: p.targetProposalId } : {}),
            },
        },
        { db },
    );
    return { proposalId: p.id, status, elementId: element.id, versionNumber: version.versionNumber };
}

async function acceptNewElement(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sessionId: string, proposalId: string, input: AcceptProposalInput): Promise<DecisionResult> {
    const peek = await EnrichmentProposalRepository.find(db, ctx.workspaceId, sessionId, ProposalIdParam.parse(proposalId));
    if (!peek || peek.bookId !== bookId) throw new NotFoundError('Proposal not found.');
    if (input.placement !== undefined && !peek.fillsSlot) {
        throw new ValidationError('Only a beat proposed for a place in the story order is placed on acceptance.', { reason: 'PLACEMENT_NOT_ALLOWED' });
    }
    // A slot's element (Phase 3.3) is placed in its kind's order. The book's lock order is names, then order, then
    // element (the bundle import takes names then every order it writes): so the names lock FIRST, then the order's,
    // and only then the name check and the create (which take the names lock again, re-entrantly). Taking the order's
    // lock before the names lock deadlocked against a concurrent import.
    const session = peek.fillsSlot ? await InterviewSessionRepository.find(db, ctx.workspaceId, bookId, sessionId) : null;
    if (peek.fillsSlot && peek.newKind) {
        await BibleElementRepository.lockNames(db, bookId);
        await BibleElementRepository.lockOrder(db, bookId, peek.newKind);
    }
    const p = await requirePending(db, ctx, bookId, sessionId, proposalId);
    if (p.kind !== 'NEW_ELEMENT') throw new ValidationError('This proposal changes a field.', { reason: 'EDIT_NOT_ALLOWED' });
    if (input.value !== undefined) throw new ValidationError('A new element takes a name and a summary, not a value.', { reason: 'EDIT_NOT_ALLOWED' });
    // Phase 3.H (D25, "refuse and ask"): a beat goes where the author chose. As proposed, only while its slot stands
    // (under the order's lock, so the check and the placement read one order); once the slot changed, the author names
    // the neighbours or accepts it unplaced. Checked before anything is written.
    if (p.fillsSlot && session && input.placement === undefined) {
        const changed = await slotChangeOf(db, ctx, bookId, session);
        if (changed) throw new ConflictError('The place this beat was proposed for has changed.', { reason: 'SLOT_CHANGED', change: changed });
    }
    const name = input.name !== undefined ? requiredLine(input.name, ELEMENT_NAME_MAX, 'Name') : requiredLine(p.newName ?? '', ELEMENT_NAME_MAX, 'Name');
    const summary = input.summary !== undefined ? (optionalBlock(input.summary, ELEMENT_SUMMARY_MAX, 'Summary') ?? null) : (optionalBlock(p.newSummary, ELEMENT_SUMMARY_MAX, 'Summary') ?? null);
    if (await bookHoldsElementName(db, ctx, bookId, name)) throw new ConflictError('The book already has an element of that name.', { reason: 'ELEMENT_EXISTS' });
    const answerIds = citationIds(p);
    // Its first fields (Phase 3.3): the slot's answers, and the act of the lane it was asked about.
    const fields = [...decodeNewElementFields(p.proposedValue)].map(([key, value]) => ({ key, value }));
    if (p.fillsSlot && session?.slotAct && getFieldDef(p.newKind!, ACT_FIELD_KEY)) fields.push({ key: ACT_FIELD_KEY, value: session.slotAct });
    // Between the slot's neighbours, or where the author chose: the place is chosen (and a spent gap rebalanced)
    // BEFORE the element is created, because creating it writes an audit row, and a rebalance after one could
    // deadlock with a writer holding a beat's row (bible-order.ts, "AUDIT LAST").
    let reserved: Awaited<ReturnType<typeof reserveOrderPlaceTx>> | null = null;
    if (p.fillsSlot && session && !(input.placement && 'unplaced' in input.placement)) {
        const target =
            input.placement && 'after' in input.placement
                ? { after: input.placement.after, before: input.placement.before }
                : { after: session.slotAfterElementId, before: session.slotBeforeElementId };
        reserved = await reserveOrderPlaceTx(db, ctx, bookId, p.newKind!, target);
    }
    const { element, version } = await createElementInTx(
        db,
        ctx,
        bookId,
        { kind: p.newKind!, name, summary, customLabel: null, fields },
        { source: 'INTERVIEW', changeSummary: optionalBlock(input.changeSummary, CHANGE_SUMMARY_MAX, 'Change summary') ?? null, sourceAnswerIds: answerIds },
    );
    // Placed where it was reserved, through the order move (one version, marked moved in order).
    const placement = reserved ? await placeNewElementInOrderTx(db, ctx, bookId, element, reserved, { source: 'INTERVIEW', sourceAnswerIds: answerIds }) : null;
    const placed = placement !== null;
    const edited = name !== p.newName || summary !== p.newSummary;
    const status: ProposalStatus = edited ? 'EDITED_ACCEPTED' : 'ACCEPTED';
    await decideOrConflict(db, ctx, p.id, { status, decidedById: ctx.userId, createdElementId: element.id });
    await logEvent(
        ctx,
        {
            action: 'ENRICHMENT_PROPOSAL_ACCEPTED',
            entityType: 'EnrichmentProposal',
            entityId: p.id,
            details: {
                bookId,
                sessionId,
                elementId: element.id,
                kind: p.newKind,
                newElement: true,
                edited,
                versionNumber: placement?.versionNumber ?? version.versionNumber,
                citedAnswerCount: answerIds.length,
                ...(p.fillsSlot ? { fillsSlot: true, placed, placement: input.placement === undefined ? 'SLOT' : 'unplaced' in input.placement ? 'UNPLACED' : 'CHOSEN' } : {}),
            },
        },
        { db },
    );
    return { proposalId: p.id, status, elementId: element.id, versionNumber: placement?.versionNumber ?? version.versionNumber, ...(p.fillsSlot ? { placed } : {}) };
}

/**
 * Accept a RELATION_FIELD proposal (Phase 3.3): as a FIELD proposal, through
 * the relation's versioned save. The relation's lock first, then the proposal
 * under it; `baseVersion` is the relation's latest (0: none yet).
 */
async function acceptRelationField(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sessionId: string, proposalId: string, input: AcceptProposalInput): Promise<DecisionResult> {
    const peek = await EnrichmentProposalRepository.find(db, ctx.workspaceId, sessionId, ProposalIdParam.parse(proposalId));
    if (!peek || peek.bookId !== bookId || !peek.relationId) throw new NotFoundError('Proposal not found.');
    await BibleRelationRepository.lock(db, peek.relationId);
    const p = await requirePending(db, ctx, bookId, sessionId, proposalId);
    const r = await requireRelationWithEnds(db, ctx, bookId, p.relationId!);
    if (input.baseVersion === undefined) throw new ValidationError('An acceptance names the version it was reviewed against.', { reason: 'BASE_VERSION_REQUIRED' });
    await assertRelationBaseVersion(db, ctx, r.id, input.baseVersion);
    if (p.baseVersion !== input.baseVersion && !input.reviewedCurrent) {
        throw new ConflictError('The relation changed since this was proposed; review its current value first.', { reason: 'PROPOSAL_OUTDATED', currentVersion: input.baseVersion, proposedAgainst: p.baseVersion });
    }
    const op = p.operation!;
    const key = p.fieldKey!;
    const current = (await readRelationFieldValues(db, ctx, r.id)).get(key) ?? null;
    if (!opFits(op, current)) throw new ConflictError('The field no longer holds what this proposal was made for.', { reason: 'PROPOSAL_STALE', operation: op });
    const relation = relationForSave(bookId, r);
    const proposed = decodeProposedValue(p.proposedValue);
    let value: FieldValue | null = proposed;
    let edited = false;
    if (input.value !== undefined) {
        if (op === 'REMOVE') throw new ValidationError('A removal has no value to edit.', { reason: 'EDIT_NOT_ALLOWED' });
        const next = normaliseRelationFieldEntries(relation, [{ key, value: input.value }]).get(key) ?? null;
        if (next === null) throw new ValidationError('An edit cannot empty the field; reject the proposal instead.', { reason: 'EDIT_NOT_ALLOWED' });
        edited = !sameFieldValue(next, proposed);
        value = next;
    }
    const changed = await writeRelationFieldValues(db, ctx, relation, [{ key, value }]);
    if (changed.length === 0) throw new ValidationError('That would change nothing.', { reason: 'EDIT_CHANGES_NOTHING' });
    const answerIds = citationIds(p);
    const version = await recordRelationVersion(db, ctx, relation, { source: 'INTERVIEW', changeSummary: optionalBlock(input.changeSummary, CHANGE_SUMMARY_MAX, 'Change summary') ?? null, sourceAnswerIds: answerIds });
    const status: ProposalStatus = edited ? 'EDITED_ACCEPTED' : 'ACCEPTED';
    await decideOrConflict(db, ctx, p.id, { status, decidedById: ctx.userId, versionId: version.id });
    const others = await EnrichmentProposalRepository.pendingForRelationField(db, ctx.workspaceId, r.id, key, p.id, 100);
    for (const o of others) await EnrichmentProposalRepository.decide(db, ctx.workspaceId, o.id, { status: 'SUPERSEDED', decidedById: ctx.userId });
    await logEvent(
        ctx,
        {
            action: 'ENRICHMENT_PROPOSAL_ACCEPTED',
            entityType: 'EnrichmentProposal',
            entityId: p.id,
            details: { bookId, sessionId, relationId: r.id, fieldKey: key, operation: op, edited, flags: p.flags, versionNumber: version.versionNumber, citedAnswerCount: answerIds.length, superseded: others.length },
        },
        { db },
    );
    return { proposalId: p.id, status, elementId: null, relationId: r.id, versionNumber: version.versionNumber };
}

/**
 * Accept a SCENE_CARD_FIELD proposal (Phase 5.3, D35): through the ONE card writer (`scene-card.ts`), which takes the
 * scene's lock, checks the versions and the operation, and writes one card version naming the answers; never the
 * scene's prose (D3). The proposal is decided, its rivals superseded, and the audit rows written last.
 */
async function acceptSceneCardField(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sessionId: string, proposalId: string, input: AcceptProposalInput): Promise<DecisionResult> {
    const peek = await EnrichmentProposalRepository.find(db, ctx.workspaceId, sessionId, ProposalIdParam.parse(proposalId));
    if (!peek || peek.bookId !== bookId || !peek.sceneId) throw new NotFoundError('Proposal not found.');
    if (input.baseVersion === undefined) throw new ValidationError('An acceptance names the version it was reviewed against.', { reason: 'BASE_VERSION_REQUIRED' });
    if (input.name !== undefined || input.summary !== undefined) throw new ValidationError('A card field has no name or summary to edit.', { reason: 'EDIT_NOT_ALLOWED' });
    if (input.value !== undefined && typeof input.value !== 'string') throw new ValidationError('A card field is text.', { reason: 'EDIT_NOT_ALLOWED' });
    const key = peek.fieldKey;
    if (!key || !isSceneCardField(key)) throw new NotFoundError('Proposal not found.');
    // The scene's lock is the writer's; it is taken BEFORE the proposal is read again, so two acceptances queue on it.
    const p = await requirePending(db, ctx, bookId, sessionId, proposalId);
    const proposed = decodeProposedValue(p.proposedValue);
    const answerIds = citationIds(p);
    const written = await acceptSceneCardFieldInTx(db, ctx, bookId, p.sceneId!, {
        fieldKey: key,
        operation: p.operation!,
        proposedValue: typeof proposed === 'string' ? proposed : null,
        ...(typeof input.value === 'string' ? { editedValue: input.value } : {}),
        proposedAgainst: p.baseVersion!,
        reviewedBase: input.baseVersion,
        reviewedCurrent: input.reviewedCurrent === true,
        answerIds,
    });
    const status: ProposalStatus = written.edited ? 'EDITED_ACCEPTED' : 'ACCEPTED';
    await decideOrConflict(db, ctx, p.id, { status, decidedById: ctx.userId, versionId: written.versionId });
    const others = await EnrichmentProposalRepository.pendingForSceneCardField(db, ctx.workspaceId, p.sceneId!, key, p.id, 100);
    for (const o of others) await EnrichmentProposalRepository.decide(db, ctx.workspaceId, o.id, { status: 'SUPERSEDED', decidedById: ctx.userId });
    // AUDIT LAST (3.H).
    await logEvent(ctx, { action: 'SCENE_CARD_SAVED', entityType: 'ManuscriptScene', entityId: p.sceneId!, details: { bookId, versionNumber: written.versionNumber, source: 'INTERVIEW', answerCount: answerIds.length } }, { db });
    await logEvent(
        ctx,
        {
            action: 'ENRICHMENT_PROPOSAL_ACCEPTED',
            entityType: 'EnrichmentProposal',
            entityId: p.id,
            details: { bookId, sessionId, sceneId: p.sceneId, fieldKey: key, operation: p.operation, edited: written.edited, flags: p.flags, versionNumber: written.versionNumber, citedAnswerCount: answerIds.length, superseded: others.length },
        },
        { db },
    );
    return { proposalId: p.id, status, elementId: null, versionNumber: written.versionNumber };
}

/**
 * Accept a NEW_RELATION proposal (Phase 3.3): each end resolved (an element of
 * the book; or a NEW_ELEMENT proposal of the session, which must have been
 * accepted first — 409 END_NOT_CREATED — and whose element must still be
 * there — 409 END_GONE), then the relation created through the one create path
 * with its note and fields, its first version INTERVIEW naming the answers.
 * Accepted as proposed: its fields are edited afterwards, like any relation's.
 */
async function acceptNewRelation(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sessionId: string, proposalId: string, input: AcceptProposalInput): Promise<DecisionResult> {
    const p = await requirePending(db, ctx, bookId, sessionId, proposalId);
    if (p.kind !== 'NEW_RELATION') throw new ValidationError('This is not a proposed relation.', { reason: 'EDIT_NOT_ALLOWED' });
    if (input.value !== undefined || input.name !== undefined || input.summary !== undefined) {
        throw new ValidationError('A proposed relation is accepted as proposed; edit its fields afterwards.', { reason: 'EDIT_NOT_ALLOWED' });
    }
    const proposedEnds = await EnrichmentProposalRepository.listEnds(db, ctx.workspaceId, sessionId, [p.newFromProposalId, p.newToProposalId].filter((x): x is string => x !== null));
    const endOf = async (elementId: string | null, endProposalId: string | null): Promise<string> => {
        if (elementId) return elementId;
        const end = proposedEnds.find((e) => e.id === endProposalId);
        if (!end || end.status === 'REJECTED' || end.status === 'SUPERSEDED') throw new ConflictError('An element this relation joins was not created.', { reason: 'END_GONE' });
        if (end.status === 'PENDING' || !end.createdElementId) throw new ConflictError('Accept the new element this relation joins first.', { reason: 'END_NOT_CREATED', proposalId: end.id });
        if (!(await BibleElementRepository.find(db, ctx.workspaceId, bookId, end.createdElementId))) throw new ConflictError('An element this relation joins has been deleted.', { reason: 'END_GONE' });
        return end.createdElementId;
    };
    const from = await endOf(p.newFromElementId, p.newFromProposalId);
    const to = await endOf(p.newToElementId, p.newToProposalId);
    const decoded = decodeNewRelation(p.proposedValue);
    const answerIds = citationIds(p);
    const created = await createRelationInTx(
        db,
        ctx,
        bookId,
        { fromElementId: from, toElementId: to, type: p.newRelationType!, note: decoded.note, fields: [...decoded.fields].map(([key, value]) => ({ key, value })) },
        { source: 'INTERVIEW', sourceAnswerIds: answerIds, changeSummary: optionalBlock(input.changeSummary, CHANGE_SUMMARY_MAX, 'Change summary') ?? null },
    );
    await decideOrConflict(db, ctx, p.id, { status: 'ACCEPTED', decidedById: ctx.userId, versionId: created.versionId, createdRelationId: created.relation.id });
    await logEvent(
        ctx,
        {
            action: 'ENRICHMENT_PROPOSAL_ACCEPTED',
            entityType: 'EnrichmentProposal',
            entityId: p.id,
            details: { bookId, sessionId, relationId: created.relation.id, type: p.newRelationType, newRelation: true, flags: p.flags, versionNumber: created.versionNumber, citedAnswerCount: answerIds.length },
        },
        { db },
    );
    return { proposalId: p.id, status: 'ACCEPTED', elementId: null, relationId: created.relation.id, versionNumber: created.versionNumber, relationEnds: { fromElementId: from, toElementId: to } };
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
    // Only a slot's beat is placed on acceptance (Phase 3.H; a new element that fills no slot is refused in its own path).
    if (parsed.placement !== undefined && kind !== 'NEW_ELEMENT') {
        throw new ValidationError('Only a beat proposed for a place in the story order is placed on acceptance.', { reason: 'PLACEMENT_NOT_ALLOWED' });
    }
    if (kind === 'FIELD') return runInWorkspaceContext(ctx, (db) => acceptField(db, ctx, bookId, sessionId, proposalId, parsed));
    if (kind === 'SCENE_CARD_FIELD') return runInWorkspaceContext(ctx, (db) => acceptSceneCardField(db, ctx, bookId, sessionId, proposalId, parsed));
    if (kind === 'RELATION_FIELD') return relationGoneAsNotFound(() => runInWorkspaceContext(ctx, (db) => acceptRelationField(db, ctx, bookId, sessionId, proposalId, parsed)));
    if (kind === 'NEW_RELATION') {
        try {
            return await runInWorkspaceContext(ctx, (db) => acceptNewRelation(db, ctx, bookId, sessionId, proposalId, parsed));
        } catch (err) {
            if (isUniqueViolation(err)) throw relationExists();
            // An end deleted by a transaction that committed while the relation was being written (its check read it
            // still there): the same answer as an end found gone.
            if (isForeignKeyViolation(err)) throw new ConflictError('An element this relation joins has been deleted.', { reason: 'END_GONE' });
            throw err;
        }
    }
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
            // A slot beat's field (Phase 3.H) waits for its beat and is decided one by one.
            if (p.kind !== 'FIELD' || p.elementId === null || p.operation !== 'ADD' || p.status !== 'PENDING' || p.citations.length === 0 || p.flags.length > 0) {
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
