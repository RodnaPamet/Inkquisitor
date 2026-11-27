/**
 * THE RULES a research run's model output is held to before anything is
 * stored (Phase 2.6; roadmap rules 2 and 1, decision D3). Pure.
 *
 * FINDINGS (`validateFindings`), in order, first failure wins:
 *   the claim and the summary sanitise to text; at least one citation; every
 *   citation names a source this run READ; every quote is long enough to mean
 *   something and occurs verbatim in that source's retrieved text
 *   (`quoteFound`), as written AND as it will be stored (sanitised); no quote carries an instruction the guard flags; no
 *   markup, script scheme, unsourced URL or flagged text in the claim or the
 *   summary; every sentence of the claim and of the summary grounded in the
 *   cited sources (2.2's `groundSentence`); no claim twice; no more findings
 *   than the depth keeps. A refused finding is counted, never stored.
 *
 * FIT (`validateFit`), in order:
 *   at least one cited finding, each one this run KEPT; ADD / UPDATE: the
 *   element is a scope element or a related one in the book (an UPDATE only a
 *   scope element, whose values the model was shown), the field is in its
 *   template, one proposal a field, the operation fits the stored value, the
 *   value is one `normaliseFieldValue` accepts, an UPDATE changes something,
 *   no copied instruction, no quoted speech the findings do not hold (D3), and
 *   every sentence grounded in the cited findings (and, for an UPDATE, the
 *   stored value); a rationale. NEW_ELEMENT: a proposable kind, a name a cited
 *   finding gives, not one the book holds. A text that addresses the product
 *   itself (an action on a field, the bible, a prompt) is FLAGGED for the
 *   author, not refused (D14, as 2.5's proposals). "No fit" names a kept
 *   finding. SCENE_NOTE (Phase 5.1): a scene the run SHOWED (its ref), one note
 *   a scene, the note plain text within its bound, no copied instruction, no
 *   quoted speech the findings do not hold, and every sentence grounded in the
 *   cited findings ALONE — never in the scene's own text, so a note can carry
 *   nothing of the manuscript back as prose (D3); a rationale; D14 flags.
 */
import type { FieldValue } from '@/lib/bible/field-values';
import { normaliseFieldValue, sameFieldValue } from '@/lib/bible/field-values';
import type { BibleKind } from '@/lib/bible/kinds';
import type { FieldDef } from '@/lib/bible/template-schema';
import { getFieldDef } from '@/lib/bible/templates';
import { plainBlock, plainLine } from '@/lib/bible/text';
import { scanInjection } from '@/lib/ai/guard';
import { addressesIn, sourceGivesAddress } from '@/lib/text/url-mentions';
import { polarityKept } from '@/lib/text/negation';
import { disclosesInstructions, promptRuns } from '@/lib/text/prompt-disclosure';
import { FINDINGS_PROMPT, FIT_PROMPT, GATHER_PROMPT } from './prompt';
import { flagsOf as enrichmentFlagsOf, groundingForm, nameKey, namedIn, paragraphsToHtml, valueAsText } from '@/lib/enrichment/validate';
import { groundSentence, normaliseText, sentences, words } from '@/lib/interview/text';
import {
    CLAIM_MAX,
    FINDING_REF_PATTERN,
    NEW_NAME_RAW_MAX,
    NO_FIT_REASON_MAX,
    RATIONALE_MAX,
    RESEARCH_PROPOSABLE_KINDS,
    SCENE_NOTE_PROPOSAL_MAX,
    SCENE_REF_PATTERN,
    SUMMARY_MAX,
    type FitProposalOutput,
    type ParsedFindings,
    type ParsedFit,
} from './schema';
import { citationForm, QUOTE_MIN_CHARS, quoteFound, sourceTextSha256, type ResearchSourceDoc } from './sources';
import type { FindingRefusal, FitRefusal, ResearchConfidence, ResearchProposalFlag } from './vocabulary';

export const NEW_ELEMENT_NAME_MAX = 120;
export const NEW_ELEMENT_SUMMARY_MAX = 1_200;

const MARKUP = /<\s*[A-Za-z!/?]/;
const SCRIPT_SCHEME = /\b(?:javascript|data|vbscript)\s*:/i;
/** A double-quoted passage of four words or more: speech, if no finding holds it. */
const QUOTED_PASSAGE = /["“]([^"“”]{8,400})["”]/g;

// ─── Findings ──────────────────────────────────────────────────────

export interface VerifiedCitation {
    readonly sourceRef: string;
    readonly kind: 'URL' | 'UPLOAD';
    readonly url: string | null;
    readonly sourceId: string | null;
    readonly title: string | null;
    readonly quotedSpan: string;
    readonly retrievedAt: string | null;
    /** URL: the SHA-256 of the page text the quote was verified in (issue #41 item 3); null for a file. */
    readonly sourceSha256: string | null;
}

export interface FindingDraft {
    /** `f1`, `f2`, … : its ref in the fit step. */
    readonly ref: string;
    readonly claim: string;
    readonly summary: string;
    readonly confidence: ResearchConfidence;
    readonly citations: readonly VerifiedCitation[];
}

export interface FindingsValidation {
    readonly findings: FindingDraft[];
    readonly refusals: Partial<Record<FindingRefusal, number>>;
    /** Items the model drafted (parsed or not). */
    readonly drafted: number;
}

function count<K extends string>(into: Partial<Record<K, number>>, code: K): void {
    into[code] = (into[code] ?? 0) + 1;
}

/** The research prompts' word runs: a drafted text holding six words of them discloses the instructions (Phase 2.H). */
const RESEARCH_RUNS = promptRuns([GATHER_PROMPT, FINDINGS_PROMPT, FIT_PROMPT]);

/** Markup, a script scheme, a URL no source gives, text the injection scanner flags, or the prompts' own words recited. */
export function carriesInjectedText(parts: readonly string[], sourceTexts: readonly string[]): boolean {
    if (disclosesInstructions(parts, RESEARCH_RUNS)) return true;
    for (const part of parts) {
        if (MARKUP.test(part) || SCRIPT_SCHEME.test(part)) return true;
        // A URL, or a bare domain (issue #39 item 4), no source gives verbatim.
        for (const address of addressesIn(part)) {
            if (!sourceGivesAddress(address, sourceTexts)) return true;
        }
        if (scanInjection(part).verdict !== 'clean') return true;
    }
    return false;
}

/** Every sentence of `text` supported by `sources` (2.2's grounding test). */
export function groundedText(text: string, sources: readonly string[], prior: readonly string[] = []): boolean {
    // 2.5's grounding form: apostrophes made one, a possessive read as its name.
    const parts = sentences(groundingForm(text));
    const folded = sources.map(groundingForm);
    const foldedPrior = prior.map(groundingForm);
    const all = foldedPrior.length === 0 ? folded : [...folded, ...foldedPrior];
    // Lexical support (from the findings and, for an UPDATE, the value it
    // replaces), and the polarity of its source kept (issue #39 item 1), the
    // findings taking precedence over the replaced value (`polarityKept`'s `prior`).
    return parts.length > 0 && parts.every((s) => groundSentence(s, all).supported && polarityKept(s, folded, foldedPrior));
}

/** Hold a findings answer to the rules; `limit` is the depth's number of findings. */
export function validateFindings(parsed: ParsedFindings, sources: readonly ResearchSourceDoc[], limit: number): FindingsValidation {
    const refusals: Partial<Record<FindingRefusal, number>> = {};
    for (let i = 0; i < parsed.malformed; i++) count(refusals, 'MALFORMED');
    const byRef = new Map(sources.map((s) => [s.ref, s] as const));
    const findings: FindingDraft[] = [];
    const seen = new Set<string>();
    for (const item of parsed.findings) {
        // Markup or a script scheme in the RAW answer is refused, not sanitised away and kept.
        if ([item.claim, item.summary].some((p) => MARKUP.test(p) || SCRIPT_SCHEME.test(p))) {
            count(refusals, 'COPIES_INJECTED_TEXT');
            continue;
        }
        const claim = plainBlock(item.claim).slice(0, CLAIM_MAX).trim();
        const summary = plainBlock(item.summary).slice(0, SUMMARY_MAX).trim();
        if (!claim || !summary) {
            count(refusals, 'CLAIM_EMPTY');
            continue;
        }
        if (item.citations.length === 0) {
            count(refusals, 'CITES_NO_SOURCE');
            continue;
        }
        let refusal: FindingRefusal | null = null;
        const citations: VerifiedCitation[] = [];
        const cited: ResearchSourceDoc[] = [];
        for (const c of item.citations) {
            const source = byRef.get(c.ref);
            if (!source) {
                refusal = 'CITES_UNKNOWN_SOURCE';
                break;
            }
            if (citationForm(c.quote).length < QUOTE_MIN_CHARS) {
                refusal = 'QUOTE_TOO_SHORT';
                break;
            }
            if (!quoteFound(c.quote, source.text)) {
                refusal = 'QUOTE_NOT_IN_SOURCE';
                break;
            }
            if (scanInjection(c.quote).verdict !== 'clean') {
                refusal = 'QUOTE_FLAGGED';
                break;
            }
            // What is STORED is the sanitised span: it must itself be a span of the
            // source, so a quote made of markup (which sanitises to nothing) or one
            // whose entities decode to other text is refused here, never stored
            // altered and never left to fail the whole run's save.
            const quotedSpan = plainBlock(c.quote).trim();
            if (!quoteFound(quotedSpan, source.text)) {
                refusal = 'QUOTE_NOT_IN_SOURCE';
                break;
            }
            if (!cited.includes(source)) cited.push(source);
            citations.push({
                sourceRef: source.ref,
                kind: source.kind,
                url: source.url,
                sourceId: source.sourceId,
                title: source.title,
                quotedSpan,
                retrievedAt: source.retrievedAt,
                sourceSha256: source.kind === 'URL' ? sourceTextSha256(source.text) : null,
            });
        }
        if (refusal) {
            count(refusals, refusal);
            continue;
        }
        const sourceTexts = cited.map((s) => s.text);
        if (carriesInjectedText([claim, summary], sourceTexts)) {
            count(refusals, 'COPIES_INJECTED_TEXT');
            continue;
        }
        if (!groundedText(claim, sourceTexts)) {
            count(refusals, 'CLAIM_UNSOURCED');
            continue;
        }
        if (!groundedText(summary, sourceTexts)) {
            count(refusals, 'SUMMARY_UNSOURCED');
            continue;
        }
        const key = normaliseText(claim);
        if (seen.has(key)) {
            count(refusals, 'DUPLICATE_CLAIM');
            continue;
        }
        if (findings.length >= limit) {
            count(refusals, 'OVER_LIMIT');
            continue;
        }
        seen.add(key);
        findings.push({ ref: `f${findings.length + 1}`, claim, summary, confidence: item.confidence, citations });
    }
    return { findings, refusals, drafted: parsed.findings.length + parsed.malformed };
}

// ─── Fit ───────────────────────────────────────────────────────────

export interface FitElement {
    readonly elementId: string;
    readonly kind: BibleKind;
    readonly name: string;
    /** `scope`: shown in full (UPDATE allowed); `related`: summary and filled keys only (ADD only). */
    readonly role: 'scope' | 'related';
    readonly stored: ReadonlyMap<string, FieldValue>;
}

/** A manuscript scene the fit step was shown (Phase 5.1), by its ref. */
export interface FitScene {
    /** `s1`, `s2`, … : its ref in the fit prompt. */
    readonly sceneRef: string;
    readonly sceneId: string;
}

export interface FitContext {
    readonly elements: readonly FitElement[];
    /** The scenes shown (Phase 5.1); none when the brief names no chapter or scene. */
    readonly scenes?: readonly FitScene[];
    readonly findings: readonly FindingDraft[];
    /**
     * The book's element names as the run read them (a first check; the
     * persist asks 2.5's `bookHoldsElementName` again, inside its transaction).
     */
    readonly bookNames: readonly string[];
}

export type FitDraft =
    | {
          readonly operation: 'ADD' | 'UPDATE';
          readonly elementId: string;
          readonly elementKind: BibleKind;
          readonly fieldKey: string;
          readonly value: FieldValue;
          readonly rationale: string;
          readonly findingRefs: readonly string[];
          readonly flags: readonly ResearchProposalFlag[];
      }
    | {
          readonly operation: 'NEW_ELEMENT';
          readonly newKind: BibleKind;
          readonly newName: string;
          readonly newSummary: string | null;
          readonly rationale: string;
          readonly findingRefs: readonly string[];
          readonly flags: readonly ResearchProposalFlag[];
      }
    | {
          readonly operation: 'SCENE_NOTE';
          readonly sceneId: string;
          /** The note, plain text (sanitised). */
          readonly note: string;
          readonly rationale: string;
          readonly findingRefs: readonly string[];
          readonly flags: readonly ResearchProposalFlag[];
      };

export interface FitValidation {
    readonly proposals: FitDraft[];
    /** Finding ref → why it fits nothing (sanitised). */
    readonly noFit: ReadonlyMap<string, string>;
    readonly refusals: Partial<Record<FitRefusal, number>>;
    readonly drafted: number;
}

type Verdict<T> = { ok: true; value: T } | { ok: false; code: FitRefusal };
const refuse = <T>(code: FitRefusal): Verdict<T> => ({ ok: false, code });
const isEmpty = (v: FieldValue | null | undefined): boolean => v === null || v === undefined || (Array.isArray(v) && v.length === 0) || v === '';

/** The texts a finding offers as a source: its claim, summary and quotes. */
function findingTexts(f: FindingDraft): string[] {
    return [f.claim, f.summary, ...f.citations.map((c) => c.quotedSpan)];
}

function readValue(def: FieldDef, raw: FitProposalOutput['value']): Verdict<{ parts: string[]; input: unknown }> {
    switch (def.type) {
        case 'text':
            return typeof raw === 'string' ? { ok: true, value: { parts: [raw], input: raw } } : refuse('VALUE_INVALID');
        case 'richtext':
            return typeof raw === 'string' ? { ok: true, value: { parts: [raw], input: paragraphsToHtml(raw) } } : refuse('VALUE_INVALID');
        case 'list':
            return Array.isArray(raw) ? { ok: true, value: { parts: raw, input: raw } } : refuse('VALUE_INVALID');
        case 'choice': {
            if (typeof raw !== 'string') return refuse('VALUE_INVALID');
            const wanted = normaliseText(raw);
            const option = def.options.find((o) => o.value === raw || normaliseText(o.label) === wanted);
            return option ? { ok: true, value: { parts: [], input: option.value } } : refuse('VALUE_INVALID');
        }
        case 'scale':
            return typeof raw === 'number' ? { ok: true, value: { parts: [], input: raw } } : refuse('VALUE_INVALID');
    }
}

/** Quoted speech in `parts` that none of the sources holds: a scene or dialogue (D3). */
export function writesProse(parts: readonly string[], sources: readonly string[]): boolean {
    const held = sources.map(citationForm);
    for (const part of parts) {
        for (const m of part.matchAll(QUOTED_PASSAGE)) {
            const inner = m[1];
            if (words(normaliseText(inner)).length < 4) continue;
            const form = citationForm(inner);
            if (!held.some((s) => s.includes(form))) return true;
        }
    }
    return false;
}

/** D14, 2.5's own reading (`flagsOf`): a text that addresses the product is flagged for the author, not refused. */
function flagsOf(parts: readonly string[]): ResearchProposalFlag[] {
    return enrichmentFlagsOf(parts);
}

function checkFindingRefs(cites: readonly string[], findings: ReadonlyMap<string, FindingDraft>): Verdict<FindingDraft[]> {
    const refs = [...new Set(cites)];
    if (refs.length === 0) return refuse('CITES_NO_FINDING');
    const out: FindingDraft[] = [];
    for (const r of refs) {
        const f = FINDING_REF_PATTERN.test(r) ? findings.get(r) : undefined;
        if (!f) return refuse('CITES_UNKNOWN_FINDING');
        out.push(f);
    }
    return { ok: true, value: out };
}

function validateFieldProposal(
    item: FitProposalOutput,
    element: FitElement,
    cited: readonly FindingDraft[],
    rationale: string,
): Verdict<FitDraft> {
    if (item.op === 'UPDATE' && element.role !== 'scope') return refuse('TARGETS_OUTSIDE_SCOPE');
    const def = item.fieldKey ? getFieldDef(element.kind, item.fieldKey) : undefined;
    if (!def) return refuse('FIELD_NOT_IN_TEMPLATE');
    const stored = element.stored.get(def.key) ?? null;
    if (item.op === 'ADD' && !isEmpty(stored)) return refuse('ADD_INTO_FILLED_FIELD');
    if (item.op === 'UPDATE' && isEmpty(stored)) return refuse('UPDATE_OF_EMPTY_FIELD');
    if (item.value === null) return refuse('VALUE_MISSING');
    const read = readValue(def, item.value);
    if (!read.ok) return read;
    const normalised = normaliseFieldValue(def, read.value.input);
    if (!normalised.ok) return refuse('VALUE_INVALID');
    if (normalised.value === null) return refuse('VALUE_MISSING');
    if (item.op === 'UPDATE' && sameFieldValue(stored, normalised.value)) return refuse('CHANGES_NOTHING');
    const sources = cited.flatMap(findingTexts);
    const allowedUrls = [...sources, ...cited.flatMap((f) => f.citations.map((c) => c.url ?? ''))];
    if (carriesInjectedText([...read.value.parts, rationale], allowedUrls)) return refuse('COPIES_INJECTED_TEXT');
    const evidence = [...sources, element.name];
    // An UPDATE may draw on the value it replaces; the findings stay the evidence (`groundedText`).
    const prior = item.op === 'UPDATE' && stored !== null ? [valueAsText(def, stored)] : [];
    const groundSources = [...evidence, ...prior];
    if (writesProse(read.value.parts, groundSources)) return refuse('WRITES_PROSE');
    if (def.type === 'text' || def.type === 'richtext' || def.type === 'list') {
        const texts = def.type === 'list' ? read.value.parts.filter((p) => p.trim() !== '') : [valueAsText(def, normalised.value)];
        if (!texts.every((t) => groundedText(t, evidence, prior))) return refuse('UNSOURCED_SENTENCE');
    }
    return {
        ok: true,
        value: {
            operation: item.op as 'ADD' | 'UPDATE',
            elementId: element.elementId,
            elementKind: element.kind,
            fieldKey: def.key,
            value: normalised.value,
            rationale,
            findingRefs: cited.map((f) => f.ref),
            flags: flagsOf([...read.value.parts, rationale]),
        },
    };
}

function validateNewElement(item: FitProposalOutput, cited: readonly FindingDraft[], rationale: string, ctx: FitContext, seen: Set<string>): Verdict<FitDraft> {
    if (!item.newKind || !(RESEARCH_PROPOSABLE_KINDS as readonly string[]).includes(item.newKind)) return refuse('KIND_NOT_PROPOSABLE');
    const name = plainLine(item.newName ?? '').slice(0, NEW_NAME_RAW_MAX).trim();
    if (!name || name.length > NEW_ELEMENT_NAME_MAX) return refuse('NAME_INVALID');
    const sources = cited.flatMap(findingTexts);
    if (!sources.some((t) => namedIn(name, t))) return refuse('NAME_NOT_IN_FINDINGS');
    const key = nameKey(name);
    if (ctx.bookNames.some((n) => nameKey(n) === key)) return refuse('ELEMENT_EXISTS');
    if (seen.has(key)) return refuse('DUPLICATE_NEW_ELEMENT');
    const summaryRaw = item.newSummary === null ? '' : plainBlock(item.newSummary).trim();
    const summary = summaryRaw === '' ? null : summaryRaw.slice(0, NEW_ELEMENT_SUMMARY_MAX);
    const parts = [name, ...(summary ? [summary] : []), rationale];
    const allowedUrls = [...sources, ...cited.flatMap((f) => f.citations.map((c) => c.url ?? ''))];
    if (carriesInjectedText(parts, allowedUrls)) return refuse('COPIES_INJECTED_TEXT');
    if (summary && writesProse([summary], sources)) return refuse('WRITES_PROSE');
    if (summary && !groundedText(summary, sources)) return refuse('UNSOURCED_SENTENCE');
    seen.add(key);
    return {
        ok: true,
        value: { operation: 'NEW_ELEMENT', newKind: item.newKind as BibleKind, newName: name, newSummary: summary, rationale, findingRefs: cited.map((f) => f.ref), flags: flagsOf(parts) },
    };
}

/** A note on a scene (Phase 5.1): the rules in the header. The scene's own text is never evidence. */
function validateSceneNote(item: FitProposalOutput, scene: FitScene, cited: readonly FindingDraft[], rationale: string): Verdict<FitDraft> {
    if (typeof item.value !== 'string') return refuse(item.value === null ? 'VALUE_MISSING' : 'VALUE_INVALID');
    const note = plainBlock(item.value).trim();
    if (!note) return refuse('VALUE_MISSING');
    if (note.length > SCENE_NOTE_PROPOSAL_MAX) return refuse('NOTE_TOO_LONG');
    const sources = cited.flatMap(findingTexts);
    const allowedUrls = [...sources, ...cited.flatMap((f) => f.citations.map((c) => c.url ?? ''))];
    if (carriesInjectedText([note, rationale], allowedUrls)) return refuse('COPIES_INJECTED_TEXT');
    if (writesProse([note], sources)) return refuse('WRITES_PROSE');
    if (!groundedText(note, sources)) return refuse('UNSOURCED_SENTENCE');
    return { ok: true, value: { operation: 'SCENE_NOTE', sceneId: scene.sceneId, note, rationale, findingRefs: cited.map((f) => f.ref), flags: flagsOf([note, rationale]) } };
}

/** Hold a fit answer to the rules. */
export function validateFit(parsed: ParsedFit, ctx: FitContext): FitValidation {
    const refusals: Partial<Record<FitRefusal, number>> = {};
    for (let i = 0; i < parsed.malformed; i++) count(refusals, 'MALFORMED');
    const findings = new Map(ctx.findings.map((f) => [f.ref, f] as const));
    const elements = new Map(ctx.elements.map((e) => [e.elementId, e] as const));
    const scenes = new Map((ctx.scenes ?? []).map((s) => [s.sceneRef, s] as const));
    const notedScenes = new Set<string>();
    const proposals: FitDraft[] = [];
    const targets = new Set<string>();
    const newNames = new Set<string>();
    for (const item of parsed.proposals) {
        const cites = checkFindingRefs(item.cites, findings);
        if (!cites.ok) {
            count(refusals, cites.code);
            continue;
        }
        const rationale = plainBlock(item.rationale).slice(0, RATIONALE_MAX).trim();
        if (!rationale) {
            count(refusals, 'RATIONALE_MISSING');
            continue;
        }
        let verdict: Verdict<FitDraft>;
        if (item.op === 'NEW_ELEMENT') {
            verdict = validateNewElement(item, cites.value, rationale, ctx, newNames);
        } else if (item.op === 'SCENE_NOTE') {
            const scene = item.sceneRef && SCENE_REF_PATTERN.test(item.sceneRef) ? scenes.get(item.sceneRef) : undefined;
            if (!scene || item.elementId !== null || item.fieldKey !== null) {
                count(refusals, 'TARGETS_OUTSIDE_SCOPE');
                continue;
            }
            if (notedScenes.has(scene.sceneId)) {
                count(refusals, 'DUPLICATE_TARGET');
                continue;
            }
            verdict = validateSceneNote(item, scene, cites.value, rationale);
            if (verdict.ok) notedScenes.add(scene.sceneId);
        } else {
            const element = item.elementId ? elements.get(item.elementId) : undefined;
            if (!element) {
                count(refusals, 'TARGETS_OUTSIDE_SCOPE');
                continue;
            }
            const target = `${element.elementId}:${item.fieldKey ?? ''}`;
            if (targets.has(target)) {
                count(refusals, 'DUPLICATE_TARGET');
                continue;
            }
            verdict = validateFieldProposal(item, element, cites.value, rationale);
            if (verdict.ok) targets.add(target);
        }
        if (verdict.ok) proposals.push(verdict.value);
        else count(refusals, verdict.code);
    }
    const noFit = new Map<string, string>();
    for (const n of parsed.noFit) {
        if (!findings.has(n.finding)) {
            count(refusals, 'NO_FIT_UNKNOWN_FINDING');
            continue;
        }
        const reason = plainBlock(n.reason).slice(0, NO_FIT_REASON_MAX).trim();
        if (!reason || carriesInjectedText([reason], findingTexts(findings.get(n.finding)!))) continue;
        if (!noFit.has(n.finding)) noFit.set(n.finding, reason);
    }
    return { proposals, noFit, refusals, drafted: parsed.proposals.length + parsed.malformed };
}

/** Sum two refusal tallies. */
export function addCounts<K extends string>(a: Partial<Record<K, number>>, b: Partial<Record<K, number>>): Partial<Record<K, number>> {
    const out: Partial<Record<K, number>> = { ...a };
    for (const [k, v] of Object.entries(b) as Array<[K, number]>) out[k] = (out[k] ?? 0) + v;
    return out;
}
