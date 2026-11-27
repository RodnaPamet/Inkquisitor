/**
 * THE RESEARCH STEPS (Phase 2.6): gather, findings, fit — the work of one run,
 * shared by the background job (`src/app-layer/usecases/research-run.ts`) and
 * the evaluation (`./evals/evaluation.ts`). Pure but for the researcher it is
 * handed; it reads and writes no table.
 *
 *   1. GATHER   the server-tool turn, its data the brief alone (D9), its every
 *               query and URL through the egress tripwire, and each told to
 *               `onEgress` as the stream delivers it (D15: the run lists them). The pages it
 *               fetched as text become sources `web.N` (deduplicated by URL,
 *               cut at `SOURCE_TEXT_MAX_CHARS`); the author's attached files
 *               are `file.N`. A gather that fails ends the run with its named
 *               failure: nothing is invented in place of a failed call.
 *   2. FINDINGS one structured call over the sources, each guard-scanned and
 *               fenced as data; every claim held to `validateFindings`.
 *   3. FIT      one structured call over the kept findings and the scope;
 *               every proposal held to `validateFit`. A fit call that fails
 *               ends the run with its failure but KEEPS the verified
 *               findings (their own call succeeded): the author can still
 *               read them and keep any as a research note.
 *
 * ZERO IS NEVER COMPLETE (rule 6): a run that keeps no finding ends DONE with
 * the reason — NO_SOURCES (nothing could be read), BUDGET_SPENT (the budget
 * went before anything was read), NO_FINDINGS (read, nothing drafted) or
 * ALL_REFUSED (drafted, every one refused) — never as a success.
 */
import type { BibleKind } from '@/lib/bible/kinds';
import type { FieldValue } from '@/lib/bible/field-values';
import type { FieldDef } from '@/lib/bible/template-schema';
import { valueAsText } from '@/lib/enrichment/validate';
import type { AuthorDataBlock } from '@/lib/ai/prompt';
import { BOOK_ELEMENTS_IN_FIT_MAX, gatherBlocks } from './prompt';
import { toolUseRefusal, type BookTextIndex } from './query-egress';
import type { GatherOutput, Researcher, StepCost } from './researcher';
import { parseFindingsOutput, parseFitOutput } from './schema';
import { SOURCES_PER_RUN_MAX, sourceTextOf, webUrlOf, type ResearchSourceDoc } from './sources';
import { validateFindings, validateFit, type FindingDraft, type FitDraft, type FitElement } from './validate';
import { DEPTH_BUDGETS, FETCH_MAX_CONTENT_TOKENS, type EgressTool, type FindingRefusal, type FitRefusal, type ResearchDepth, type ResearchOutcome, type RunProgress } from './vocabulary';

export interface ScopeElementInput {
    readonly elementId: string;
    readonly kind: BibleKind;
    readonly name: string;
    readonly summary: string | null;
    readonly role: 'scope' | 'related';
    readonly fields: readonly FieldDef[];
    readonly stored: ReadonlyMap<string, FieldValue>;
}

/**
 * A manuscript scene the fit step is shown (Phase 5.1): the brief's scoped
 * chapters' scenes and its scoped scenes, each by a ref (`s1`, …). Author text,
 * so fenced as data and guard-scanned like every block; never in the gather
 * request (D9, D15).
 */
export interface FitSceneInput {
    readonly sceneRef: string;
    readonly sceneId: string;
    readonly title: string | null;
    readonly chapterTitle: string | null;
    readonly pov: string | null;
    readonly setting: string | null;
    readonly storyTime: string | null;
    /** The opening of the scene's text, plain (`SCENE_EXCERPT_CHARS`, cut at a word). */
    readonly excerpt: string;
}

export interface ResearchRunInput {
    readonly bookId: string;
    readonly brief: { readonly question: string; readonly purpose: string; readonly urls: readonly string[] };
    readonly depth: ResearchDepth;
    readonly uploads: ReadonlyArray<{ readonly sourceId: string; readonly filename: string; readonly text: string }>;
    readonly elements: readonly ScopeElementInput[];
    readonly bookNames: readonly string[];
    readonly bookIndex: BookTextIndex;
    /** The manuscript scenes the fit step may note (Phase 5.1); none when the brief names no chapter or scene. */
    readonly scenes?: readonly FitSceneInput[];
}

export interface ResearchMetrics {
    searches: number;
    fetches: number;
    requests: number;
    gatherStop: string | null;
    sourcesRead: number;
    findingsDrafted: number;
    findingsKept: number;
    findingRefusals: Partial<Record<FindingRefusal, number>>;
    proposalsDrafted: number;
    proposalsKept: number;
    fitRefusals: Partial<Record<FitRefusal, number>>;
    noFit: number;
    tokensUsed: number;
    costMicroUsd: number;
    callIds: string[];
    reviewRequired: boolean;
    guardRuleIds: string[];
    errorCode?: string;
    /** D15: queries and URLs listed on the run, and those past the list's bound (counted, said). Set by the run's usecase. */
    egressListed?: number;
    egressUnlisted?: number;
    /** Phase 5.1: manuscript scenes the fit step was shown, and those past its bound (counted). Set by the run's usecase. */
    scenesShown?: number;
    scenesCut?: number;
}

export interface ResearchStepsResult {
    readonly outcome: ResearchOutcome;
    readonly sources: readonly ResearchSourceDoc[];
    readonly findings: readonly FindingDraft[];
    readonly proposals: readonly FitDraft[];
    readonly noFit: ReadonlyMap<string, string>;
    readonly metrics: ResearchMetrics;
}

export type ProgressObserver = (progress: RunProgress) => void;

/** One query or fetch URL the gather turn sent, as the tripwire judged it (decision D15: every one is listed). */
export interface EgressSeen {
    readonly tool: EgressTool;
    /** The query or URL as the model wrote it (an unreadable input as it came). */
    readonly input: unknown;
    /** The tripwire's refusal code, or null. */
    readonly refusal: string | null;
}
export type EgressObserver = (seen: EgressSeen) => void;

/** The gather turn's web tools for a depth (the caps a test pins). */
export function webToolsForDepth(depth: ResearchDepth) {
    const b = DEPTH_BUDGETS[depth];
    return {
        tools: { search: { maxUses: b.searches }, fetch: { maxUses: b.fetches, maxContentTokens: FETCH_MAX_CONTENT_TOKENS } },
        maxRequests: b.requests,
        budgetMicroUsd: b.gatherSpendMicroUsd,
    };
}

/** The sources the findings step reads: fetched pages as text, then attached files. */
export function sourcesOf(gather: Pick<GatherOutput, 'fetches'> | null, uploads: ResearchRunInput['uploads']): ResearchSourceDoc[] {
    const out: ResearchSourceDoc[] = [];
    const seen = new Set<string>();
    for (const f of gather?.fetches ?? []) {
        if (f.text === null || f.text.trim() === '') continue;
        const url = webUrlOf(f.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        out.push({ ref: `web.${out.filter((s) => s.kind === 'URL').length + 1}`, kind: 'URL', url, sourceId: null, title: f.title, text: sourceTextOf(f.text), retrievedAt: f.retrievedAt });
    }
    let files = 0;
    for (const u of uploads) {
        if (u.text.trim() === '') continue;
        files += 1;
        out.push({ ref: `file.${files}`, kind: 'UPLOAD', url: null, sourceId: u.sourceId, title: u.filename, text: sourceTextOf(u.text), retrievedAt: null });
    }
    return out.slice(0, SOURCES_PER_RUN_MAX);
}

/** The findings call's data blocks: the brief's question and purpose, then each source. */
export function findingsBlocks(brief: ResearchRunInput['brief'], sources: readonly ResearchSourceDoc[]): AuthorDataBlock[] {
    return [
        { label: 'brief.question', text: brief.question },
        { label: 'brief.purpose', text: brief.purpose },
        ...sources.map((s) => ({ label: `source.${s.ref}`, text: JSON.stringify({ ref: s.ref, title: s.title, url: s.url, text: s.text }) })),
    ];
}

/** The fit call's data blocks: the brief, each kept finding, each element (scope in full, related as summary and filled keys), the book's names. */
export function fitBlocks(input: ResearchRunInput, findings: readonly FindingDraft[]): AuthorDataBlock[] {
    const blocks: AuthorDataBlock[] = [
        { label: 'brief.question', text: input.brief.question },
        { label: 'brief.purpose', text: input.brief.purpose },
    ];
    for (const f of findings) {
        blocks.push({ label: `finding.${f.ref}`, text: JSON.stringify({ ref: f.ref, claim: f.claim, summary: f.summary, quotes: f.citations.map((c) => c.quotedSpan) }) });
    }
    input.elements.forEach((e, i) => {
        const fields = e.fields.map((d) => ({
            key: d.key,
            label: d.label,
            type: d.type,
            ...(d.type === 'choice' ? { options: d.options.map((o) => o.value) } : {}),
            ...(e.role === 'related' ? { filled: e.stored.has(d.key) } : {}),
        }));
        const stored: Record<string, string> = {};
        if (e.role === 'scope') for (const [k, v] of e.stored) {
            const def = e.fields.find((d) => d.key === k);
            if (def) stored[k] = valueAsText(def, v);
        }
        blocks.push({
            label: `element.${i + 1}`,
            text: JSON.stringify({ elementId: e.elementId, kind: e.kind, name: e.name, role: e.role, summary: e.summary, fields, ...(e.role === 'scope' ? { stored_values: stored } : {}) }),
        });
    });
    blocks.push({ label: 'book.elements', text: JSON.stringify(input.bookNames.slice(0, BOOK_ELEMENTS_IN_FIT_MAX)) });
    for (const s of input.scenes ?? []) {
        blocks.push({
            label: `scene.${s.sceneRef}`,
            text: JSON.stringify({ sceneRef: s.sceneRef, title: s.title, chapter: s.chapterTitle, pov: s.pov, setting: s.setting, storyTime: s.storyTime, opening: s.excerpt }),
        });
    }
    return blocks;
}

export function fitElementsOf(input: ResearchRunInput): FitElement[] {
    return input.elements.map((e) => ({ elementId: e.elementId, kind: e.kind, name: e.name, role: e.role, stored: e.stored }));
}

function emptyMetrics(): ResearchMetrics {
    return {
        searches: 0,
        fetches: 0,
        requests: 0,
        gatherStop: null,
        sourcesRead: 0,
        findingsDrafted: 0,
        findingsKept: 0,
        findingRefusals: {},
        proposalsDrafted: 0,
        proposalsKept: 0,
        fitRefusals: {},
        noFit: 0,
        tokensUsed: 0,
        costMicroUsd: 0,
        callIds: [],
        reviewRequired: false,
        guardRuleIds: [],
    };
}

function charge(m: ResearchMetrics, cost: StepCost): void {
    m.tokensUsed += cost.tokensUsed;
    m.costMicroUsd += cost.costMicroUsd;
    m.callIds.push(...cost.callIds);
    if (cost.reviewRequired) m.reviewRequired = true;
    if (cost.guardRuleIds) m.guardRuleIds = [...new Set([...m.guardRuleIds, ...cost.guardRuleIds])].sort();
}

/** Run the three steps. Never throws for a model condition: every one is a named outcome. */
export async function runResearchSteps(
    input: ResearchRunInput,
    researcher: Researcher,
    observe: ProgressObserver = () => {},
    signal?: AbortSignal,
    onEgress: EgressObserver = () => {},
): Promise<ResearchStepsResult> {
    const metrics = emptyMetrics();
    const none = new Map<string, string>();
    const progress = (p: Partial<RunProgress> & Pick<RunProgress, 'phase'>) =>
        observe({ searches: metrics.searches, fetches: metrics.fetches, sources: metrics.sourcesRead, findings: metrics.findingsKept, proposals: metrics.proposalsKept, ...p });
    const end = (outcome: ResearchOutcome, sources: readonly ResearchSourceDoc[] = [], findings: readonly FindingDraft[] = [], proposals: readonly FitDraft[] = [], noFit: ReadonlyMap<string, string> = none): ResearchStepsResult => ({
        outcome,
        sources,
        findings,
        proposals,
        noFit,
        metrics,
    });

    // 1. Gather: the brief alone, the egress tripwire on every tool use.
    progress({ phase: 'searching' });
    const plan = webToolsForDepth(input.depth);
    const gathered = await researcher.gather(
        {
            data: gatherBlocks(input.brief),
            tools: plan.tools,
            maxRequests: plan.maxRequests,
            budgetMicroUsd: plan.budgetMicroUsd,
            inspectToolUse: (use) => {
                const refusal = toolUseRefusal(use, input.bookIndex);
                if (use.tool === 'web_search' || use.tool === 'web_fetch') {
                    const raw = use.input as { query?: unknown; url?: unknown } | null;
                    const text = use.tool === 'web_search' ? raw?.query : raw?.url;
                    try {
                        onEgress({ tool: use.tool, input: typeof text === 'string' ? text : use.input, refusal });
                    } catch {
                        // Told, never asked: a failing observer changes nothing about the run.
                    }
                }
                return refusal;
            },
            bookId: input.bookId,
        },
        {
            onToolUse: (c) => {
                metrics.searches = c.searches;
                metrics.fetches = c.fetches;
                progress({ phase: c.fetches > 0 ? 'reading' : 'searching' });
            },
        },
        signal,
    );
    if (!gathered.ok) {
        charge(metrics, gathered);
        metrics.errorCode = gathered.errorCode;
        return end(gathered.failure);
    }
    const g = gathered.output;
    charge(metrics, g);
    metrics.searches = g.searches.length;
    metrics.fetches = g.fetches.length;
    metrics.requests = g.requests;
    metrics.gatherStop = g.stop;
    const sources = sourcesOf(g, input.uploads);
    metrics.sourcesRead = sources.length;
    if (sources.length === 0) return end(g.stop === 'BUDGET' || g.stop === 'REQUEST_CAP' ? 'BUDGET_SPENT' : 'NO_SOURCES');

    // 2. Findings: every claim on a verified quote.
    progress({ phase: 'drafting_findings' });
    const drafted = await researcher.findings({ data: findingsBlocks(input.brief, sources), bookId: input.bookId }, signal);
    charge(metrics, drafted);
    if (!drafted.ok) {
        metrics.errorCode = drafted.errorCode;
        return end(drafted.failure, sources);
    }
    const checked = validateFindings(parseFindingsOutput(drafted.output), sources, DEPTH_BUDGETS[input.depth].findings);
    metrics.findingsDrafted = checked.drafted;
    metrics.findingsKept = checked.findings.length;
    metrics.findingRefusals = checked.refusals;
    if (checked.findings.length === 0) return end(checked.drafted === 0 ? 'NO_FINDINGS' : 'ALL_REFUSED', sources);

    // 3. Fit: how each finding bears on the scope.
    progress({ phase: 'fitting' });
    const fitted = await researcher.fit({ data: fitBlocks(input, checked.findings), bookId: input.bookId }, signal);
    charge(metrics, fitted);
    if (!fitted.ok) {
        metrics.errorCode = fitted.errorCode;
        return end(fitted.failure, sources, checked.findings);
    }
    const fit = validateFit(parseFitOutput(fitted.output), {
        elements: fitElementsOf(input),
        findings: checked.findings,
        bookNames: input.bookNames,
        scenes: (input.scenes ?? []).map((s) => ({ sceneRef: s.sceneRef, sceneId: s.sceneId })),
    });
    metrics.proposalsDrafted = fit.drafted;
    metrics.proposalsKept = fit.proposals.length;
    metrics.fitRefusals = fit.refusals;
    metrics.noFit = fit.noFit.size;
    progress({ phase: 'saving' });
    return end('OK', sources, checked.findings, fit.proposals, fit.noFit);
}
