/**
 * THE DRAFT HELD AGAINST THE BIBLE — the author's decisions (Phase 5.3, D35; rule 1, D3). `bible.view` reads,
 * `bible.edit` decides. Nothing here calls a model, writes a scene's text, or writes the bible unless the author saves.
 *
 *   read        `getSceneDraftNotes`: one scene's open mismatches (the margin's draft notes, each placed only where
 *               the text it was read from still stands — `atCurrentText` and the editor's own check of the quote), its
 *               thread links, and whether it was read at all (rule 6: "not read yet", never "no mismatches").
 *   decide      `decideDraftMismatch`, a PENDING mismatch only (409 PROPOSAL_DECIDED otherwise), under the book's fact
 *               lock (taken alone):
 *                 FIX_DRAFT   FIX_PENDING — the author will fix the draft; the next read of the scene after an edit that
 *                             no longer makes the claim settles it FIXED. Nothing writes the scene's text (D3).
 *                 BOTH_TRUE   KEPT — an explanation is REQUIRED, sanitised, and stored as an AUTHOR_RESOLUTION fact naming
 *                             the mismatch (4.2's "both true"); the same claim is never raised again while it stands.
 *   update      "Update the bible" (D35 item 3): `getDraftUpdatePrefill` opens the bible entry's FIELD the bible fact
 *               rests on (its section of the version it was drawn from, else 4.0's predicate table), PREFILLED with the
 *               draft's value (`draftPrefill`) — nothing saved; then `updateBibleFromDraft` is the AUTHOR'S OWN SAVE of
 *               the value they edited: the element's lock, its base version (409 VERSION_CONFLICT), the field's own rules,
 *               one version of source MANUSCRIPT naming the scene (CHECK `BibleEntryVersion_manuscript_names_scene`),
 *               and in the same transaction the mismatch decided BIBLE_UPDATED — only while it is still PENDING (else
 *               409 PROPOSAL_DECIDED and nothing is written). A save that changes nothing writes nothing (400
 *               NOTHING_CHANGED). The decision is recorded when the author's save lands, never before.
 *
 * Audit last, ids and codes only.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository, BibleVersionRepository } from '@/app-layer/repositories/bible.repository';
import { ContinuityFactRepository } from '@/app-layer/repositories/continuity.repository';
import {
    DraftFactRepository,
    DraftMismatchRepository,
    SceneDraftReadRepository,
    scenesInOrder,
    ThreadSceneLinkRepository,
    type DraftFactRow,
    type DraftMismatchRow,
} from '@/app-layer/repositories/draft-facts.repository';
import { BibleVersionReadRepository } from '@/app-layer/repositories/fact-layer.repository';
import { BibleFactRepository, StoryFactRepository } from '@/app-layer/repositories/source.repository';
import { StoryThreadRepository } from '@/app-layer/repositories/continuity.repository';
import { DraftMismatchDecisionInput, DraftUpdateBibleInput } from '@/app-layer/schemas/draft';
import { parseSnapshot } from '@/lib/bible/snapshot';
import { getFieldDef } from '@/lib/bible/templates';
import type { BibleKind } from '@/lib/bible/kinds';
import { sanitiseExplanationForStorage } from '@/lib/continuity/storage';
import { draftTextKey } from '@/lib/draft-facts/keys';
import { draftPrefill } from '@/lib/draft-facts/prefill';
import { cursorReadItsText, DRAFT_LIST_MAX, OPEN_DRAFT_STATUSES, type DraftMismatchStatus, type DraftMismatchView, type DraftUpdatePrefillView, type SceneLinkView } from '@/lib/draft-facts/vocabulary';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { renderElementEntry } from '@/lib/facts/entry-text';
import { fieldAnsweredBy } from '@/lib/sources/vocabulary';
import { sanitiseFactForStorage } from '@/lib/sources/storage';
import { assertBaseVersion, readFieldValues, recordVersion, requireBook, requireElement, writeFieldValues } from './bible-common';

/** The field types "Update the bible" opens (a scale states no fact a draft can contradict). */
const UPDATABLE_TYPES: ReadonlySet<string> = new Set(['text', 'richtext', 'list', 'choice']);

/** A mismatch's sides, as one list's views read them (bounded by the rows given). */
export async function draftMismatchViews(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, rows: readonly DraftMismatchRow[]): Promise<DraftMismatchView[]> {
    if (rows.length === 0) return [];
    const bibleFacts = new Map((await BibleFactRepository.listAnyByIds(db, ctx.workspaceId, [...new Set(rows.map((r) => r.factId))])).map((f) => [f.id, f] as const));
    const anchors = new Map((await DraftFactRepository.byIds(db, ctx.workspaceId, [...new Set(rows.map((r) => r.newerFactId).filter((x): x is string => !!x))])).map((f) => [f.id, f] as const));
    // A mismatch carried over a re-read is shown where its claim now stands (the scene's live draft fact of that claim).
    const current = await DraftFactRepository.liveByKeys(
        db,
        ctx.workspaceId,
        bookId,
        rows.filter((r) => r.sceneId && r.draftClaimKey).map((r) => ({ sceneId: r.sceneId!, dedupeKey: r.draftClaimKey! })),
    );
    const currentOf = new Map(current.map((f) => [`${f.sceneId}|${f.dedupeKey}`, f] as const));
    const elementIds = [...new Set([...bibleFacts.values()].map((f) => f.elementId).filter((x): x is string => !!x))];
    const names = new Map((await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, elementIds)).map((e) => [e.id, e.name] as const));
    const versions = await BibleVersionReadRepository.elementVersionNumbers(db, ctx.workspaceId, [...bibleFacts.values()].map((f) => f.bibleVersionId).filter((x): x is string => !!x));
    const scenes = new Map((await scenesInOrder(db, ctx.workspaceId, bookId, [...new Set(rows.map((r) => r.sceneId).filter((x): x is string => !!x))])).map((s) => [s.id, s] as const));
    const explanations = await ContinuityFactRepository.explanationsFor(db, ctx.workspaceId, rows.filter((r) => r.status === 'KEPT').map((r) => r.id));
    const out: DraftMismatchView[] = [];
    for (const r of rows) {
        const b = bibleFacts.get(r.factId);
        const anchor = r.newerFactId ? anchors.get(r.newerFactId) : undefined;
        if (!b || !anchor || !r.sceneId) continue;
        const d: DraftFactRow = currentOf.get(`${r.sceneId}|${r.draftClaimKey}`) ?? anchor;
        out.push({
            id: r.id,
            status: r.status as DraftMismatchStatus,
            kind: r.kind ?? 'OTHER',
            createdAt: r.createdAt.toISOString(),
            sceneId: r.sceneId,
            sceneTitle: scenes.get(r.sceneId)?.title ?? null,
            draft: { statement: d.statement, quote: d.quote, subjectName: d.subjectName, predicate: d.predicate, start: d.quoteStart, end: d.quoteEnd, live: d.supersededAt === null },
            bible: {
                statement: b.statement,
                quote: b.quote,
                subjectName: b.subjectName,
                predicate: b.predicate,
                elementId: b.elementId,
                elementName: b.elementId ? (names.get(b.elementId) ?? null) : null,
                versionNumber: b.bibleVersionId ? (versions.get(b.bibleVersionId) ?? null) : null,
                live: b.supersededAt === null,
            },
            canUpdateBible: r.status === 'PENDING' && b.sourceKind === 'BIBLE_VERSION' && b.supersededAt === null,
            explanation: explanations.get(r.id)?.statement ?? null,
        });
    }
    return out;
}

/** A book's thread links as views (titles of their threads and scenes). */
export async function threadLinkViews(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, rows: Awaited<ReturnType<typeof ThreadSceneLinkRepository.forBook>>): Promise<SceneLinkView[]> {
    if (rows.length === 0) return [];
    const threads = new Map((await StoryThreadRepository.byIds(db, ctx.workspaceId, bookId, [...new Set(rows.map((r) => r.threadId))])).map((t) => [t.id, { title: t.title, kind: t.kind }] as const));
    const scenes = new Map((await scenesInOrder(db, ctx.workspaceId, bookId, [...new Set(rows.map((r) => r.sceneId))])).map((s) => [s.id, s] as const));
    return rows.flatMap((r) => {
        const t = threads.get(r.threadId);
        if (!t) return [];
        return [{
            id: r.id,
            threadId: r.threadId,
            threadTitle: t.title,
            threadKind: t.kind,
            sceneId: r.sceneId,
            sceneTitle: scenes.get(r.sceneId)?.title ?? null,
            role: r.role as SceneLinkView['role'],
            status: r.status as SceneLinkView['status'],
            quote: r.quote,
            start: r.quoteStart,
            end: r.quoteEnd,
            flags: r.flags,
            createdAt: r.createdAt.toISOString(),
        }];
    });
}

export interface SceneDraftNotesView {
    /** Rule 6: whether the scene's CURRENT text was read (false: "not read yet" — never "no mismatches"). */
    readAtCurrentText: boolean;
    /** It was read at some text before (its notes may be from an older text: placed only where their quote still stands). */
    everRead: boolean;
    readOutcome: string | null;
    /** Its current text was PASSED OVER (it failed every night, no call over it fits the per-call budget, or the guard refused every piece): not read until it changes. */
    passedOver: boolean;
    mismatches: DraftMismatchView[];
    /** Placed by the editor only when the quote was read from the text as it stands. */
    currentTextKeyMatches: Record<string, boolean>;
    links: SceneLinkView[];
    truncated: boolean;
}

/** One scene's draft notes (the scene editor's margin and side panel). */
export async function getSceneDraftNotes(ctx: WorkspaceRequestContext, bookId: string, sceneId: string): Promise<SceneDraftNotesView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const scene = await SceneDraftReadRepository.sceneForRead(db, ctx.workspaceId, bookId, sceneId);
        if (!scene) throw new NotFoundError('Scene not found.');
        const textKey = draftTextKey(ctx.workspaceId, scene.text);
        const read = await SceneDraftReadRepository.find(db, ctx.workspaceId, bookId, sceneId);
        const rows = await DraftMismatchRepository.forScene(db, ctx.workspaceId, bookId, sceneId, OPEN_DRAFT_STATUSES, DRAFT_LIST_MAX + 1);
        const mismatches = await draftMismatchViews(db, ctx, bookId, rows.slice(0, DRAFT_LIST_MAX));
        const liveDraft = await DraftFactRepository.liveForScene(db, ctx.workspaceId, bookId, sceneId);
        const atText = new Map(liveDraft.map((f) => [f.id, f.sceneTextKey === textKey] as const));
        const currentTextKeyMatches: Record<string, boolean> = {};
        for (const m of mismatches) {
            const live = liveDraft.find((f) => f.quoteStart === m.draft.start && f.quoteEnd === m.draft.end && f.quote === m.draft.quote);
            currentTextKeyMatches[m.id] = !!live && atText.get(live.id) === true;
        }
        const linkRows = await ThreadSceneLinkRepository.forScene(db, ctx.workspaceId, bookId, sceneId, ['PENDING', 'CONFIRMED'], DRAFT_LIST_MAX + 1);
        const links = await threadLinkViews(db, ctx, bookId, linkRows.slice(0, DRAFT_LIST_MAX));
        return {
            // Read at this text: the cursor names it AND records a read of it (a text that failed, or was passed over or
            // over the per-call budget, was not read — its notes, if any, are from an earlier text).
            readAtCurrentText: !!read && read.textKey === textKey && cursorReadItsText(read) && read.outcome !== 'GUARD_REFUSED',
            everRead: !!read && read.revision >= 0,
            readOutcome: read?.outcome ?? null,
            passedOver: !!read && read.textKey === textKey && (read.outcome === 'PASSED_OVER' || read.outcome === 'CALL_OVER_BUDGET' || read.outcome === 'GUARD_REFUSED'),
            mismatches,
            currentTextKeyMatches,
            links,
            truncated: rows.length > DRAFT_LIST_MAX || linkRows.length > DRAFT_LIST_MAX,
        };
    });
}

/** Decide a draft mismatch: FIX_DRAFT or BOTH_TRUE (the header). */
export async function decideDraftMismatch(ctx: WorkspaceRequestContext, bookId: string, proposalId: string, input: unknown): Promise<{ id: string; status: DraftMismatchStatus; explanationFactId: string | null }> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const parsed = DraftMismatchDecisionInput.parse(input);
        let explanation: string | null = null;
        if (parsed.decision === 'BOTH_TRUE') {
            if (!parsed.explanation || parsed.explanation.trim() === '') throw new ValidationError('Say how both can be true.', { reason: 'EXPLANATION_REQUIRED' });
            try {
                explanation = sanitiseExplanationForStorage(parsed.explanation);
            } catch {
                throw new ValidationError('Say how both can be true.', { reason: 'EXPLANATION_REQUIRED' });
            }
        }
        await BibleFactRepository.lockBook(db, bookId);
        const mismatch = await DraftMismatchRepository.find(db, ctx.workspaceId, bookId, proposalId);
        if (!mismatch) throw new NotFoundError('Proposal not found.');
        if (mismatch.status !== 'PENDING') throw new ConflictError('This mismatch was already decided.', { reason: 'PROPOSAL_DECIDED', status: mismatch.status });
        const at = new Date();
        const status = parsed.decision === 'FIX_DRAFT' ? 'FIX_PENDING' : 'KEPT';
        if (!(await DraftMismatchRepository.decide(db, ctx.workspaceId, mismatch.id, { status, decidedById: ctx.userId, at }))) {
            throw new ConflictError('This mismatch was already decided.', { reason: 'PROPOSAL_DECIDED' });
        }
        let explanationFactId: string | null = null;
        if (explanation !== null) {
            const [bible] = await BibleFactRepository.listAnyByIds(db, ctx.workspaceId, [mismatch.factId]);
            // The explanation is stored as a fact: through the fact sanitiser like every other fact's text (4.2's KEEP_BOTH).
            const fact = sanitiseFactForStorage({
                position: 0,
                subjectName: bible?.subjectName || 'Explanation',
                predicate: 'OTHER',
                objectLiteral: null,
                statement: explanation,
                quote: explanation,
                quoteStart: 0,
                quoteEnd: explanation.length,
                storyTimeFrom: null,
                storyTimeTo: null,
                flags: [],
            });
            explanationFactId = (
                await StoryFactRepository.createResolutionFact(db, ctx.workspaceId, {
                    bookId,
                    resolvesProposalId: mismatch.id,
                    subjectName: fact.subjectName,
                    subjectElementId: bible?.subjectElementId ?? null,
                    statement: fact.statement,
                    decidedById: ctx.userId,
                    at,
                })
            ).id;
        }
        // AUDIT LAST (3.H).
        await logEvent(ctx, { action: 'DRAFT_MISMATCH_DECIDED', entityType: 'StoryFactProposal', entityId: mismatch.id, details: { bookId, sceneId: mismatch.sceneId, decision: parsed.decision, kind: mismatch.kind, explanationFactId } }, { db });
        return { id: mismatch.id, status, explanationFactId };
    });
}

/** The field a bible fact rests on: its section of the version it was drawn from, else the predicate's field; null when none can be updated. */
async function fieldOfBibleFact(db: PrismaTx, ctx: WorkspaceRequestContext, fact: { bibleVersionId: string | null; quoteStart: number; predicate: string }, kind: BibleKind): Promise<string | null> {
    if (fact.bibleVersionId) {
        const version = await BibleVersionReadRepository.elementVersion(db, ctx.workspaceId, fact.bibleVersionId);
        if (version) {
            const entry = renderElementEntry(parseSnapshot(version.snapshot));
            let offset = 0;
            for (const section of [...entry.header, ...entry.body]) {
                const line = `${section.label}: ${section.text}`;
                if (fact.quoteStart >= offset && fact.quoteStart < offset + line.length) {
                    const def = getFieldDef(kind, section.key);
                    if (def && UPDATABLE_TYPES.has(def.type)) return def.key;
                    break;
                }
                offset += line.length + 1;
            }
        }
    }
    const byPredicate = fieldAnsweredBy(kind, fact.predicate);
    const def = byPredicate ? getFieldDef(kind, byPredicate) : undefined;
    return def && UPDATABLE_TYPES.has(def.type) ? def.key : null;
}

/** The mismatch, its two facts, the element and the field "Update the bible" opens — or a refusal by name. */
async function updateTarget(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, proposalId: string) {
    const mismatch = await DraftMismatchRepository.find(db, ctx.workspaceId, bookId, proposalId);
    if (!mismatch || !mismatch.newerFactId || !mismatch.sceneId) throw new NotFoundError('Proposal not found.');
    if (mismatch.status !== 'PENDING') throw new ConflictError('This mismatch was already decided.', { reason: 'PROPOSAL_DECIDED', status: mismatch.status });
    const [bible] = await BibleFactRepository.listAnyByIds(db, ctx.workspaceId, [mismatch.factId]);
    if (!bible || bible.sourceKind !== 'BIBLE_VERSION' || !bible.elementId || bible.supersededAt) {
        throw new ConflictError('The bible fact this mismatch is about no longer stands.', { reason: 'BIBLE_FACT_GONE' });
    }
    const element = await requireElement(db, ctx, bookId, bible.elementId);
    const [anchor] = await DraftFactRepository.byIds(db, ctx.workspaceId, [mismatch.newerFactId]);
    const [current] = await DraftFactRepository.liveByKeys(db, ctx.workspaceId, bookId, mismatch.draftClaimKey ? [{ sceneId: mismatch.sceneId, dedupeKey: mismatch.draftClaimKey }] : []);
    const draft = current ?? anchor;
    if (!draft) throw new NotFoundError('Proposal not found.');
    const fieldKey = await fieldOfBibleFact(db, ctx, { bibleVersionId: bible.bibleVersionId, quoteStart: bible.quoteStart, predicate: bible.predicate }, element.kind as BibleKind);
    if (!fieldKey) throw new ConflictError('No field of this entry holds that fact.', { reason: 'NO_FIELD_TO_UPDATE' });
    return { mismatch, bible, element, draft, fieldKey, sceneId: mismatch.sceneId };
}

/** "Update the bible": the field, its current value, and the draft's value prefilled (nothing saved). */
export async function getDraftUpdatePrefill(ctx: WorkspaceRequestContext, bookId: string, proposalId: string): Promise<DraftUpdatePrefillView> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const t = await updateTarget(db, ctx, bookId, proposalId);
        const def = getFieldDef(t.element.kind as BibleKind, t.fieldKey)!;
        const values = await readFieldValues(db, ctx, t.element.id);
        const current = values.get(t.fieldKey) ?? null;
        const prefill = draftPrefill({ fieldType: def.type, current, bibleQuote: t.bible.quote, bibleObject: t.bible.objectLiteral, draftObject: t.draft.objectLiteral, draftQuote: t.draft.quote });
        const baseVersion = await latestVersion(db, ctx, t.element.id);
        const [scene] = await scenesInOrder(db, ctx.workspaceId, bookId, [t.sceneId]);
        return {
            proposalId,
            elementId: t.element.id,
            elementName: t.element.name,
            fieldKey: t.fieldKey,
            fieldLabel: def.label,
            fieldType: def.type,
            field: def,
            baseVersion,
            current,
            prefill: prefill.value,
            prefillBasis: prefill.basis,
            draftQuote: t.draft.quote,
            sceneId: t.sceneId,
            sceneTitle: scene?.title ?? null,
        };
    });
}

async function latestVersion(db: PrismaTx, ctx: WorkspaceRequestContext, elementId: string): Promise<number> {
    return BibleVersionRepository.latestNumber(db, ctx.workspaceId, elementId);
}

/** The author's own save of the field (the header): one MANUSCRIPT version naming the scene, and the mismatch decided. */
export async function updateBibleFromDraft(ctx: WorkspaceRequestContext, bookId: string, proposalId: string, input: unknown): Promise<{ id: string; status: 'BIBLE_UPDATED'; elementId: string; versionNumber: number }> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = DraftUpdateBibleInput.parse(input);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const peek = await updateTarget(db, ctx, bookId, proposalId);
        // The versioned save (1.1, 1.H): the element's lock, then its base version, then the field's own rules.
        await BibleElementRepository.lock(db, peek.element.id);
        const element = await requireElement(db, ctx, bookId, peek.element.id);
        await assertBaseVersion(db, ctx, element.id, parsed.baseVersion);
        const changed = await writeFieldValues(db, ctx, element, [{ key: peek.fieldKey, value: parsed.value }]);
        if (changed.length === 0) throw new ValidationError('That value is what the bible already says.', { reason: 'NOTHING_CHANGED' });
        await BibleElementRepository.touch(db, ctx.workspaceId, bookId, element.id);
        const version = await recordVersion(db, ctx, bookId, element.id, { source: 'MANUSCRIPT', sourceSceneId: peek.sceneId });
        const at = new Date();
        // Recorded with the save, or not at all: a mismatch decided meanwhile refuses the save (nothing is written).
        if (!(await DraftMismatchRepository.decide(db, ctx.workspaceId, peek.mismatch.id, { status: 'BIBLE_UPDATED', decidedById: ctx.userId, at }))) {
            throw new ConflictError('This mismatch was already decided.', { reason: 'PROPOSAL_DECIDED' });
        }
        // AUDIT LAST (3.H).
        await logEvent(
            ctx,
            { action: 'DRAFT_BIBLE_UPDATED', entityType: 'StoryFactProposal', entityId: peek.mismatch.id, details: { bookId, sceneId: peek.sceneId, elementId: element.id, versionNumber: version.versionNumber, fieldKeyCount: 1 } },
            { db },
        );
        return { id: peek.mismatch.id, status: 'BIBLE_UPDATED', elementId: element.id, versionNumber: version.versionNumber };
    });
}
