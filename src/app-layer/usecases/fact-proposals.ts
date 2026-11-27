/**
 * REVIEWING PROPOSALS TO INVALIDATE A FACT (Phase 4.1, D27; rule 1). A live
 * fact a newer one contradicts, or one its entry no longer states, is never
 * retired by the product: both stay live, and the author decides.
 *
 *   read     `bible.view`: a book's PENDING proposals (newest first, at most
 *            `FACT_PROPOSALS_PER_VIEW_MAX`, a cut said), each with both facts
 *            and where each came from (the bible entry and its version, or the
 *            source and its passage).
 *   decide   `bible.edit`, under the book's fact lock, a PENDING proposal only
 *            (409 PROPOSAL_DECIDED otherwise, nothing written):
 *              INVALIDATE  the older fact is superseded by the newer
 *                          (`supersededAt`, `invalidatedByFactId`, once); every
 *                          other pending proposal to invalidate it is settled
 *                          with it. 409 FACT_NOT_LIVE when it is already gone.
 *              KEEP_BOTH   both are true (different times, both readings hold).
 *              REJECT      not a contradiction.
 *            KEEP_BOTH and REJECT write only the decision; the pair is never
 *            proposed again (the database's one-proposal-per-pair key). Audit
 *            last, ids and codes.
 *
 * PHASE 4.2 (D28) extends the record and its decision: a contradiction has a
 * KIND (and may be raised by the nightly DEEP check), and the author may keep
 * the OLDER fact instead (INVALIDATE_NEWER: the newer is superseded by the
 * older), or keep both and EXPLAIN — `explanation` is required for a
 * contradiction's KEEP_BOTH, sanitised, and stored as a fact of its own
 * (AUTHOR_RESOLUTION, CONFIRMED, naming the proposal) in the same transaction.
 * Invalidating a fact settles every other pending proposal it stands in, as
 * the older or the newer. The review lives on the Continuity page; nothing here
 * calls a model or writes the bible.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository, BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
import { BibleVersionReadRepository, FactProposalRepository, type FactProposalRow } from '@/app-layer/repositories/fact-layer.repository';
import { BibleFactRepository, SourceRepository, StoryFactRepository } from '@/app-layer/repositories/source.repository';
import { getRelationType } from '@/lib/bible/templates';
import type { BibleKind } from '@/lib/bible/kinds';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError } from '@/lib/errors/types';
import { FACT_PROPOSALS_PER_VIEW_MAX, STATUS_OF_DECISION, type FactProposalBasis, type FactProposalDecision, type FactProposalReason } from '@/lib/facts/vocabulary';
import { FactProposalDecisionInput } from '@/app-layer/schemas/sources';
import { ValidationError } from '@/lib/errors/types';
import { sanitiseExplanationForStorage } from '@/lib/continuity/storage';
import { sanitiseFactForStorage } from '@/lib/sources/storage';
import type { ContradictionKind } from '@/lib/continuity/vocabulary';
import { requireBook } from './bible-common';

export interface ProposalFactView {
    id: string;
    subjectName: string;
    predicate: string;
    statement: string;
    quote: string;
    storyTimeFrom: string | null;
    storyTimeTo: string | null;
    live: boolean;
    origin:
        | { kind: 'ELEMENT'; elementName: string | null; versionNumber: number | null }
        | { kind: 'RELATION'; label: string | null }
        | { kind: 'SOURCE'; filename: string | null; version: number | null }
        /** Phase 4.2: the author's own explanation of a contradiction they resolved as both true. */
        | { kind: 'AUTHOR' };
}

export interface FactProposalView {
    id: string;
    reason: FactProposalReason;
    basis: FactProposalBasis;
    /** Phase 4.2: what cannot both hold (a contradiction), or null. */
    kind: ContradictionKind | null;
    createdAt: string;
    older: ProposalFactView;
    newer: ProposalFactView | null;
}

export interface FactProposalsPage {
    proposals: FactProposalView[];
    pending: number;
    truncated: boolean;
}

export async function views(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, rows: readonly FactProposalRow[]): Promise<FactProposalView[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.factId, ...(r.newerFactId ? [r.newerFactId] : [])]))];
    const facts = new Map((await BibleFactRepository.listAnyByIds(db, ctx.workspaceId, ids)).map((f) => [f.id, f] as const));
    const elementIds = [...new Set([...facts.values()].map((f) => f.elementId).filter((x): x is string => !!x))];
    const relationIds = [...new Set([...facts.values()].map((f) => f.relationId).filter((x): x is string => !!x))];
    const sourceIds = [...new Set([...facts.values()].map((f) => f.sourceId).filter((x): x is string => !!x))];
    const elements = new Map((await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, elementIds)).map((e) => [e.id, e.name] as const));
    const relations = new Map((await BibleRelationRepository.listByIdsWithEnds(db, ctx.workspaceId, bookId, relationIds)).map((r) => [r.id, r] as const));
    const sources = new Map((await SourceRepository.listByIds(db, ctx.workspaceId, sourceIds)).map((s) => [s.id, s] as const));
    const versions = await BibleVersionReadRepository.elementVersionNumbers(db, ctx.workspaceId, [...facts.values()].map((f) => f.bibleVersionId).filter((x): x is string => !!x));
    const view = (id: string): ProposalFactView | null => {
        const f = facts.get(id);
        if (!f) return null;
        let origin: ProposalFactView['origin'];
        if (f.sourceKind === 'BIBLE_VERSION') origin = { kind: 'ELEMENT', elementName: f.elementId ? (elements.get(f.elementId) ?? null) : null, versionNumber: f.bibleVersionId ? (versions.get(f.bibleVersionId) ?? null) : null };
        else if (f.sourceKind === 'RELATION_VERSION') {
            const r = f.relationId ? relations.get(f.relationId) : undefined;
            const type = r ? getRelationType(r.from.kind as BibleKind, r.type) : undefined;
            origin = { kind: 'RELATION', label: r ? `${r.from.name} — ${type?.label ?? r.type} — ${r.to.name}` : null };
        } else if (f.sourceKind === 'AUTHOR_RESOLUTION') {
            origin = { kind: 'AUTHOR' };
        } else {
            const s = f.sourceId ? sources.get(f.sourceId) : undefined;
            origin = { kind: 'SOURCE', filename: s?.filename ?? null, version: s?.version ?? null };
        }
        return { id: f.id, subjectName: f.subjectName, predicate: f.predicate, statement: f.statement, quote: f.quote, storyTimeFrom: f.storyTimeFrom, storyTimeTo: f.storyTimeTo, live: f.supersededAt === null, origin };
    };
    const out: FactProposalView[] = [];
    for (const r of rows) {
        const older = view(r.factId);
        if (!older) continue;
        out.push({ id: r.id, reason: r.reason as FactProposalReason, basis: r.basis as FactProposalBasis, kind: (r.kind as ContradictionKind | null) ?? null, createdAt: r.createdAt.toISOString(), older, newer: r.newerFactId ? view(r.newerFactId) : null });
    }
    return out;
}

/** A book's pending proposals (the header's read). */
export async function listFactProposals(ctx: WorkspaceRequestContext, bookId: string): Promise<FactProposalsPage> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const rows = await FactProposalRepository.listForBook(db, ctx.workspaceId, bookId, 'PENDING', FACT_PROPOSALS_PER_VIEW_MAX + 1);
        const pending = await FactProposalRepository.countPending(db, ctx.workspaceId, bookId);
        return { proposals: await views(db, ctx, bookId, rows.slice(0, FACT_PROPOSALS_PER_VIEW_MAX)), pending, truncated: rows.length > FACT_PROPOSALS_PER_VIEW_MAX };
    });
}

/** Decide one proposal (the header's decide). `input` is `{ decision }`, read after the book is found (a deleted book is a 404 whatever the body). */
export async function decideFactProposal(ctx: WorkspaceRequestContext, bookId: string, proposalId: string, input: unknown): Promise<{ id: string; status: string; explanationFactId: string | null }> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const parsed = FactProposalDecisionInput.parse(input);
        const decision: FactProposalDecision = parsed.decision;
        await BibleFactRepository.lockBook(db, bookId);
        const proposal = await FactProposalRepository.find(db, ctx.workspaceId, bookId, proposalId);
        if (!proposal) throw new NotFoundError('Proposal not found.');
        // Phase 5.3: a draft mismatch (basis DRAFT) has its own three choices and its own route (`draft-mismatches.ts`);
        // keeping one side here would set a bible fact aside for a draft's sentence, which is never canon.
        if (proposal.basis === 'DRAFT') throw new ConflictError('This is a draft mismatch: decide it from the draft list.', { reason: 'NOT_A_CONTINUITY_PROPOSAL' });
        if (proposal.status !== 'PENDING') throw new ConflictError('This proposal was already decided.', { reason: 'PROPOSAL_DECIDED', status: proposal.status });
        // Phase 4.2 (D28): keeping the older fact is a contradiction's answer only (there is no newer fact otherwise).
        if (decision === 'INVALIDATE_NEWER' && !proposal.newerFactId) throw new ValidationError('Only a contradiction has a newer fact to set aside.', { reason: 'NO_NEWER_FACT' });
        // "Both are true" of a contradiction carries the author's explanation, which becomes a fact (sanitised first).
        let explanation: string | null = null;
        if (decision === 'KEEP_BOTH' && proposal.reason === 'CONTRADICTED') {
            if (!parsed.explanation || parsed.explanation.trim() === '') throw new ValidationError('Say how both can be true.', { reason: 'EXPLANATION_REQUIRED' });
            try {
                explanation = sanitiseExplanationForStorage(parsed.explanation);
            } catch {
                throw new ValidationError('Say how both can be true.', { reason: 'EXPLANATION_REQUIRED' });
            }
        }
        const at = new Date();
        const status = STATUS_OF_DECISION[decision];
        let settled = 0;
        let explanationFactId: string | null = null;
        if (decision === 'INVALIDATE' || decision === 'INVALIDATE_NEWER') {
            const gone = decision === 'INVALIDATE' ? proposal.factId : proposal.newerFactId!;
            const by = decision === 'INVALIDATE' ? proposal.newerFactId : proposal.factId;
            if (!(await BibleFactRepository.supersede(db, ctx.workspaceId, gone, { at, byFactId: by }))) {
                throw new ConflictError('That fact no longer stands.', { reason: 'FACT_NOT_LIVE' });
            }
            await FactProposalRepository.decide(db, ctx.workspaceId, proposal.id, { status, decidedById: ctx.userId, at });
            settled = (await FactProposalRepository.settleAllForFact(db, ctx.workspaceId, gone, { decidedById: ctx.userId, at })) + 1;
        } else {
            await FactProposalRepository.decide(db, ctx.workspaceId, proposal.id, { status, decidedById: ctx.userId, at });
            if (explanation !== null) {
                const [older] = await BibleFactRepository.listAnyByIds(db, ctx.workspaceId, [proposal.factId]);
                // The explanation is stored as a fact: through the fact sanitiser like every other fact's text.
                const fact = sanitiseFactForStorage({
                    position: 0,
                    subjectName: older?.subjectName || 'Explanation',
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
                        resolvesProposalId: proposal.id,
                        subjectName: fact.subjectName,
                        subjectElementId: older?.subjectElementId ?? null,
                        statement: fact.statement,
                        decidedById: ctx.userId,
                        at,
                    })
                ).id;
            }
            settled = 1;
        }
        // AUDIT LAST (3.H).
        await logEvent(
            ctx,
            { action: 'STORY_FACT_PROPOSAL_DECIDED', entityType: 'StoryFactProposal', entityId: proposal.id, details: { bookId, decision, reason: proposal.reason, kind: proposal.kind, settled, explanationFactId } },
            { db },
        );
        return { id: proposal.id, status, explanationFactId };
    });
}
