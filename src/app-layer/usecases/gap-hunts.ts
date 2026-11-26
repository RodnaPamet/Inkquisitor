/**
 * THE GAP HUNT (Phase 4.3, D29): which kinds and fields the rest of the book
 * depends on and leaves empty, ranked for THIS story, and the next three
 * sessions. Nothing here writes the bible.
 *
 *   CANDIDATES  computed by code before any model is asked
 *               (`computeGapCandidates`): the book's elements (at most
 *               `GAP_ELEMENTS_READ_MAX`, a cut said), what each holds — stored
 *               values, and fields a live fact answers (rule 5's reading) — and
 *               each kind's relations, facts and citing entries.
 *   RANKING     on demand, from the Interrogate page, after the author has seen
 *               the call's "at most" (`runGapHunt`, `bible.edit`): ONE cheap
 *               balanced call over the candidates and a bounded view of the book,
 *               charged to the model-call minute, held to the monthly ceiling and
 *               the kill switch, its worst case inside the ENFORCED per-call
 *               budget, and only on an evaluation record this deployment accepts
 *               (D11). Every pick is validated (`validateGapPicks`).
 *   UNRANKED    when no call can be made (the kill switch, no deployment, the
 *               ceiling, D11, the budget, the rate minute) or it fails or keeps no
 *               pick, the CODE'S OWN ORDER is stored and shown LABELLED UNRANKED
 *               with the reason — never passed off as the model's.
 *   STORED      every run is a `GapHunt` row (the picks' reasons encrypted), the
 *               newest shown with whether the book has changed since
 *               (`bookVersionMark`): a cached ranking, refreshed when the author
 *               asks. It is never scheduled, so it spends nothing on its own.
 */
import type { Prisma } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository } from '@/app-layer/repositories/bible.repository';
import { bookVersionMark, gapSignals, GapHuntRepository, type GapHuntRow } from '@/app-layer/repositories/interrogation.repository';
import type { AuthorDataBlock } from '@/lib/ai/prompt';
import type { BibleKind } from '@/lib/bible/kinds';
import { getTemplate } from '@/lib/bible/templates';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, RateLimitedError } from '@/lib/errors/types';
import { computeGapCandidates, type GapKindSignals } from '@/lib/gap-hunt/candidates';
import { gapRankWorstCase } from '@/lib/gap-hunt/cost';
import { defaultGapRanker, type GapRanker } from '@/lib/gap-hunt/model-seam';
import { GAP_BOOK_VIEW_MAX_CHARS, GAP_RANK_CALL_COST_BUDGET_MICRO_USD, GAP_RANK_PROMPT_VERSION, gapRankBlocks } from '@/lib/gap-hunt/prompt';
import { gapRankGate, type GapRankGateVerdict } from '@/lib/gap-hunt/record-gate';
import { proposedSessions, type ProposedSession } from '@/lib/gap-hunt/sessions';
import { decodeGapPicks, sanitiseGapPicksForStorage } from '@/lib/gap-hunt/storage';
import { unrankedPicks, validateGapPicks } from '@/lib/gap-hunt/validate';
import { GAP_ELEMENTS_READ_MAX, GAP_HUNTS_LISTED_MAX, type GapCandidate, type GapPick, type GapUnrankedReason } from '@/lib/gap-hunt/vocabulary';
import { CODE_DEFAULT_DIALS } from '@/lib/interview/dial-settings';
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import { chargeModelCalls } from '@/lib/security/model-call-rate-limit';
import { requireBook } from './bible-common';
import { deploymentPackRecordMode } from './interview-packs';
import { storedTextOf } from './interview-state';
import { modelBudgetState, modelUnavailableReason } from './model-calls';
import { bibleFactRefs, sourceFactRefs } from './source-retrieval';

export interface GapHuntDeps {
    ranker?: (ctx: WorkspaceRequestContext) => GapRanker;
    recordMode?: PackRecordMode;
    gate?: () => GapRankGateVerdict;
    charge?: (workspaceId: string, calls: number) => void;
    /** A call's worst case (tests: a figure of their own). */
    worstCase?: (blocks: readonly AuthorDataBlock[]) => number;
}

/** What a gap hunt reads: the code's candidates, the book view the call may be shown, and the book's mark. */
interface GapInput {
    candidates: GapCandidate[];
    book: { title: string; logline: string | null };
    elements: Array<{ id: string; kind: string; name: string; summary: string | null }>;
    elementCount: number;
    elementsCut: boolean;
    mark: number;
}

/** Kinds the book view leads with: the ones that say what the story is. */
const VIEW_FIRST: readonly string[] = ['PREMISE', 'THEME', 'CHARACTER', 'PLOT'];

async function readGapInput(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string): Promise<GapInput> {
    const book = await requireBook(db, ctx, bookId);
    const rows = await BibleElementRepository.listForInterview(db, ctx.workspaceId, bookId, { take: GAP_ELEMENTS_READ_MAX + 1 });
    const elements = rows.slice(0, GAP_ELEMENTS_READ_MAX);
    const stored = await storedTextOf(db, ctx, elements.map((e) => e.id));
    const scope = elements.map((e) => ({ elementId: e.id, kind: e.kind, name: e.name }));
    const answered = [...(await bibleFactRefs(db, ctx, bookId, scope)), ...(await sourceFactRefs(db, ctx, bookId, scope))];
    const filled = new Map<string, Set<string>>(elements.map((e) => [e.id, new Set(stored.get(e.id)?.keys() ?? [])]));
    for (const r of answered) filled.get(r.elementId)?.add(r.fieldKey);
    const signals = new Map<BibleKind, GapKindSignals>((await gapSignals(db, ctx.workspaceId, bookId)).map((s) => [s.kind as BibleKind, { relations: s.relations, facts: s.facts, citations: s.citations }]));
    const candidates = computeGapCandidates({ elements: elements.map((e) => ({ id: e.id, kind: e.kind, filledKeys: filled.get(e.id) ?? new Set() })), signals, template: getTemplate });
    const view = [...elements].sort((a, b) => rank(a.kind) - rank(b.kind));
    return {
        candidates,
        book: { title: book.title, logline: book.logline ?? null },
        elements: view.map((e) => ({ id: e.id, kind: e.kind, name: e.name, summary: e.summary })),
        elementCount: elements.length,
        elementsCut: rows.length > GAP_ELEMENTS_READ_MAX,
        mark: await bookVersionMark(db, ctx.workspaceId, bookId),
    };
}

function rank(kind: string): number {
    const i = VIEW_FIRST.indexOf(kind);
    return i === -1 ? VIEW_FIRST.length : i;
}

/** The call's blocks inside the per-call budget: the full book view, then halved twice; null when none fits. */
function fittedBlocks(input: GapInput, worst: (b: readonly AuthorDataBlock[]) => number): { blocks: AuthorDataBlock[]; worstMicroUsd: number } | null {
    for (let chars = GAP_BOOK_VIEW_MAX_CHARS; chars >= GAP_BOOK_VIEW_MAX_CHARS / 4; chars /= 2) {
        const blocks = gapRankBlocks(input, chars);
        const w = worst(blocks);
        if (w <= GAP_RANK_CALL_COST_BUDGET_MICRO_USD) return { blocks, worstMicroUsd: w };
    }
    return null;
}

/** Why the model cannot rank here now, before any call (a code), or null. */
function unrankableReason(deps: GapHuntDeps): GapUnrankedReason | null {
    const reason = modelUnavailableReason();
    if (reason) return reason === 'AI_DISABLED' ? 'KILL_SWITCH' : 'AI_UNAVAILABLE';
    const verdict = (deps.gate ?? (() => gapRankGate(deps.recordMode ?? deploymentPackRecordMode())))();
    return verdict.mounted ? null : 'NOT_EVALUATED';
}

// ─── Views ─────────────────────────────────────────────────────────

export interface GapHuntView {
    /** The stored hunt, or null for the page's unranked preview (nothing run yet). */
    id: string | null;
    ranked: boolean;
    unrankedReason: GapUnrankedReason | null;
    candidates: GapCandidate[];
    picks: GapPick[];
    sessions: ProposedSession[];
    /** The book has changed since this hunt ran (a different version count). */
    changedSince: boolean;
    elementsCut: boolean;
    costMicroUsd: number;
    createdAt: string | null;
    /** The names of the elements a proposed session is started on (ELEMENT sessions), by id. */
    elementNames: Record<string, string>;
}

export interface GapHuntPage {
    /** Rule 6: false for a book with nothing in it (no candidate can be measured). */
    assessed: boolean;
    /** The newest stored hunt, else the code's unranked order now. */
    hunt: GapHuntView;
    /** Can the model rank now, and at most for how much; or why not (a code). */
    ranking: { available: true; worstMicroUsd: number } | { available: false; reason: GapUnrankedReason };
    canEdit: boolean;
}

function namesFor(sessions: readonly ProposedSession[], input: GapInput): Record<string, string> {
    const byId = new Map(input.elements.map((e) => [e.id, e.name] as const));
    const out: Record<string, string> = {};
    for (const s of sessions) if (s.target.scope === 'ELEMENT' && byId.has(s.target.elementId)) out[s.target.elementId] = byId.get(s.target.elementId)!;
    return out;
}

function viewOfRow(row: GapHuntRow, input: GapInput): GapHuntView {
    const mark = input.mark;
    const candidates = (Array.isArray(row.candidates) ? row.candidates : []) as unknown as GapCandidate[];
    const picks = decodeGapPicks(row.picks);
    const sessions = proposedSessions(picks, candidates, CODE_DEFAULT_DIALS.depth);
    return {
        elementNames: namesFor(sessions, input),
        id: row.id,
        ranked: row.ranked,
        unrankedReason: (row.unrankedReason as GapUnrankedReason | null) ?? null,
        candidates,
        picks,
        sessions,
        changedSince: row.bookMark !== mark,
        elementsCut: row.elementsCut,
        costMicroUsd: Number(row.costMicroUsd),
        createdAt: row.createdAt.toISOString(),
    };
}

function previewOf(input: GapInput, reason: GapUnrankedReason): GapHuntView {
    const picks = unrankedPicks(input.candidates);
    const sessions = proposedSessions(picks, input.candidates, CODE_DEFAULT_DIALS.depth);
    return { id: null, ranked: false, unrankedReason: reason, candidates: input.candidates, picks, sessions, changedSince: false, elementsCut: input.elementsCut, costMicroUsd: 0, createdAt: null, elementNames: namesFor(sessions, input) };
}

/** The Interrogate page's gap hunt half (`bible.view`). */
export async function getGapHuntPage(ctx: WorkspaceRequestContext, bookId: string, deps: GapHuntDeps = {}): Promise<GapHuntPage> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        const input = await readGapInput(db, ctx, bookId);
        const latest = await GapHuntRepository.latestForBook(db, ctx.workspaceId, bookId);
        const reason = unrankableReason(deps);
        const fitted = reason ? null : fittedBlocks(input, deps.worstCase ?? ((b) => gapRankWorstCase(b)));
        return {
            assessed: input.elementCount > 0,
            hunt: latest ? viewOfRow(latest, input) : previewOf(input, reason ?? 'NO_VALID_PICK'),
            ranking: reason ? { available: false, reason } : fitted ? { available: true, worstMicroUsd: fitted.worstMicroUsd } : { available: false, reason: 'CALL_OVER_BUDGET' },
            canEdit: ctx.permissions.bible.edit,
        };
    });
}

/** Run a gap hunt (`bible.edit`; the header): ranked by the model when it can be, else the code's order, labelled. */
export async function runGapHunt(ctx: WorkspaceRequestContext, bookId: string, input: { confirmWorstCaseMicroUsd?: number }, deps: GapHuntDeps = {}): Promise<GapHuntView> {
    await assertPermission(ctx, 'bible.edit');
    const read = await runInWorkspaceContext(ctx, (db) => readGapInput(db, ctx, bookId));
    if (read.elementCount === 0) throw new ConflictError('There is nothing in this book to rank yet.', { reason: 'NOTHING_TO_RANK' });
    if (read.candidates.length === 0) throw new ConflictError('No field the book holds is left empty.', { reason: 'NO_GAPS' });
    const worst = deps.worstCase ?? ((b: readonly AuthorDataBlock[]) => gapRankWorstCase(b));

    let reason: GapUnrankedReason | null = unrankableReason(deps);
    const fitted = reason ? null : fittedBlocks(read, worst);
    if (!reason && !fitted) reason = 'CALL_OVER_BUDGET';
    if (!reason && fitted) {
        const budget = await runInWorkspaceContext(ctx, (db) => modelBudgetState(db, ctx, fitted.worstMicroUsd));
        if (budget.killSwitch) reason = 'KILL_SWITCH';
        else if (budget.workspaceCeilingReached) reason = 'WORKSPACE_CEILING';
    }
    // The author confirms what a call may cost; nothing is confirmed for the code's own order, which costs nothing.
    if (!reason && fitted && (input.confirmWorstCaseMicroUsd === undefined || !Number.isFinite(input.confirmWorstCaseMicroUsd) || input.confirmWorstCaseMicroUsd < fitted.worstMicroUsd)) {
        throw new ConflictError('The cost changed since it was shown; confirm the new amount.', { reason: 'ESTIMATE_CHANGED', worstCaseMicroUsd: fitted.worstMicroUsd });
    }
    if (!reason) {
        try {
            (deps.charge ?? chargeModelCalls)(ctx.workspaceId, 1);
        } catch (err) {
            if (!(err instanceof RateLimitedError)) throw err;
            reason = 'MODEL_RATE_LIMITED';
        }
    }

    let picks: GapPick[] = unrankedPicks(read.candidates);
    let costMicroUsd = 0;
    let refusals: Record<string, number> = {};
    let called = false;
    if (!reason && fitted) {
        // THE CALL (outside every transaction).
        const result = await (deps.ranker ?? ((c: WorkspaceRequestContext) => defaultGapRanker(c)))(ctx).extract({ data: fitted.blocks, bookId });
        called = true;
        costMicroUsd = result.costMicroUsd;
        if (!result.ok) {
            reason =
                result.failure === 'KILL_SWITCH' ? 'KILL_SWITCH'
                : result.failure === 'WORKSPACE_CEILING' ? 'WORKSPACE_CEILING'
                : result.failure === 'AI_UNAVAILABLE' ? 'AI_UNAVAILABLE'
                : result.failure === 'GUARD_REFUSED' ? 'GUARD_REFUSED'
                : 'CALL_FAILED';
        } else {
            const v = validateGapPicks(result.output, { candidates: read.candidates, text: fitted.blocks.map((b) => b.text).join('\n') });
            refusals = Object.fromEntries(Object.entries(v.refusals).map(([k, n]) => [k, n ?? 0]));
            if (v.picks.length === 0) reason = 'NO_VALID_PICK';
            else picks = v.picks;
        }
    }
    if (reason) picks = unrankedPicks(read.candidates);

    return runInWorkspaceContext(ctx, async (db) => {
        const row = await GapHuntRepository.create(db, ctx.workspaceId, {
            bookId,
            ranked: reason === null,
            unrankedReason: reason,
            candidates: read.candidates as unknown as Prisma.InputJsonValue,
            picks: sanitiseGapPicksForStorage(picks),
            bookMark: read.mark,
            elementsCut: read.elementsCut,
            costMicroUsd,
            promptVersion: called ? GAP_RANK_PROMPT_VERSION : null,
            refusals,
            createdById: ctx.userId,
        });
        await GapHuntRepository.pruneForBook(db, ctx.workspaceId, bookId, GAP_HUNTS_LISTED_MAX);
        // AUDIT LAST.
        await logEvent(ctx, { action: 'GAP_HUNT_RUN', entityType: 'GapHunt', entityId: row.id, details: { bookId, ranked: reason === null, unrankedReason: reason, candidates: read.candidates.length, picks: picks.length } }, { db });
        // The hunt THIS request stored (never "the newest", which a concurrent run may have written since).
        const stored = await GapHuntRepository.find(db, ctx.workspaceId, bookId, row.id);
        return viewOfRow(stored!, read);
    });
}
