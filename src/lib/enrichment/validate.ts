/**
 * CODE DECIDES WHETHER A PROPOSED BIBLE CHANGE MAY BE OFFERED (Phase 2.5;
 * design section 9; roadmap rules 1 and 2). Pure: no database, no model.
 *
 * The reconcile step's model says, per field the round targeted, ADD, UPDATE,
 * REMOVE or NO_CHANGE, with a value and the answers it is drawn from, and
 * names new elements. Nothing it says is trusted. Every operation is held to
 * these rules, in this order; the first that fails REFUSES it with its code
 * (`REFUSAL_CODES`), and a refused proposal is never stored or shown —
 * refused, not softened:
 *
 *   1  in scope       the element and field are ones the round's questions
 *                     targeted (`TARGETS_OUT_OF_SCOPE_FIELD`); one operation per
 *                     field (`DUPLICATE_TARGET`). A volunteered detail about
 *                     another field yields nothing: the author can be asked.
 *   2  op fits        ADD only into an empty field, UPDATE and REMOVE only on a
 *                     filled one; NO_CHANGE always, and writes nothing.
 *   3  cites          at least one answer (`CITES_NO_ANSWER`), each one of the
 *                     answers this run was given (`CITES_FOREIGN_ANSWER`: another
 *                     session's, another round's, an older revision or an id
 *                     made up), each ANSWERED (`CITES_UNANSWERED`).
 *   4  typed value    REMOVE carries none; ADD and UPDATE carry one that
 *                     `normaliseFieldValue` accepts for the field's type and
 *                     bounds (sanitised there), that is not empty, and (UPDATE)
 *                     that differs from the stored value.
 *   5  no injection   no markup, no URL that a clean cited answer did not give,
 *                     nothing the 2.1 guard's injection scanner flags, no
 *                     sentence that addresses the product itself (an action
 *                     on a field, the bible, a prompt, a citation by answer
 *                     id: `addressesTheProduct`) (`COPIES_INJECTED_TEXT`).
 *   6  grounded       every sentence of a text value, every list item, a
 *                     choice's option and a scale's number is supported by the
 *                     cited answers and, for an UPDATE, the stored value
 *                     (`groundSentence`, design 4.5: 70 % of its content words
 *                     and every capitalised word occur in them). One
 *                     unsupported sentence refuses the whole proposal
 *                     (`UNSOURCED_SENTENCE`).
 *
 * A new element passes when its kind may be proposed (not CUSTOM, which needs
 * the author's own label), its name is a non-empty line within the element
 * name's bound that occurs, whole words, in a cited answer (otherwise the
 * model invented it), the book holds no element of that name, the same answer
 * does not propose it twice, its citations pass rule 3 and its summary, if
 * any, passes rules 5 and 6.
 *
 * The output is what may be STORED: the sanitised value, the citations, and
 * the refusals by code for the run's metrics.
 */
import { getFieldDef } from '@/lib/bible/templates';
import type { FieldDef } from '@/lib/bible/template-schema';
import type { BibleKind } from '@/lib/bible/kinds';
import { normaliseFieldValue, sameFieldValue, type FieldValue } from '@/lib/bible/field-values';
import { escapeHtml } from '@/lib/bible/snapshot-text';
import { plainBlock, plainLine } from '@/lib/bible/text';
import { normalizeForScan, scanInjection } from '@/lib/ai/guard';
import { groundSentence, normaliseText, sentences, words } from '@/lib/interview/text';
import { PROPOSABLE_KINDS, type NewElementOutput, type ParsedReconcile, type ReconcileOperation } from './schema';
import type { RefusalCode, StoredOp } from './vocabulary';

/** A new element's name, at most (the bible's own bound, `ELEMENT_NAME_MAX`). */
export const NEW_ELEMENT_NAME_MAX = 120;
/** A new element's summary, at most once sanitised. */
export const NEW_ELEMENT_SUMMARY_MAX = 1_200;

/** An element of the round's scope, as reconcile sees it. */
export interface ReconcileScopeElement {
    elementId: string;
    kind: BibleKind;
    /** Every stored field value, decoded (the op-fit rule reads it). */
    stored: ReadonlyMap<string, FieldValue>;
    /** The keys the round's questions targeted on this element. */
    scopeKeys: readonly string[];
}

/** One of the round's answers (its latest revision), as reconcile sees it. */
export interface ReconcileAnswerFact {
    answerId: string;
    status: 'ANSWERED' | 'SKIPPED' | 'DECIDE_LATER';
    /** The answer as text (choice, scale and text joined), or null when not ANSWERED. */
    text: string | null;
    /** A SCALE answer's number. */
    scale: number | null;
}

export interface ValidationContext {
    elements: readonly ReconcileScopeElement[];
    /** The round's answers this run was given: the only citable ids. */
    answers: readonly ReconcileAnswerFact[];
    /** Names of the book's elements (the new-element rule). */
    bookElementNames: readonly string[];
}

export interface FieldProposalDraft {
    kind: 'FIELD';
    elementId: string;
    fieldKey: string;
    operation: StoredOp;
    /** The sanitised value to store; null for REMOVE. */
    value: FieldValue | null;
    citedAnswerIds: string[];
}

export interface NewElementDraft {
    kind: 'NEW_ELEMENT';
    newKind: BibleKind;
    name: string;
    summary: string | null;
    citedAnswerIds: string[];
}

export type ProposalDraft = FieldProposalDraft | NewElementDraft;

export interface Refusal {
    code: RefusalCode;
    /** What it was about, in ids and keys (never a value). */
    target: { elementId?: string; fieldKey?: string; kind?: string };
}

export interface ValidationResult {
    proposals: ProposalDraft[];
    refusals: Refusal[];
    /** Operations the model answered NO_CHANGE (and that were in scope): written nowhere, counted. */
    noChange: number;
}

type Verdict<T> = { ok: true; value: T } | { ok: false; code: RefusalCode };
const refuse = <T>(code: RefusalCode): Verdict<T> => ({ ok: false, code });

const isEmpty = (v: FieldValue | null | undefined): boolean => v === null || v === undefined || (Array.isArray(v) && v.length === 0) || v === '';

/** Rule 3: the citations, deduplicated, or why not. */
export function checkCitations(cites: readonly string[], answers: readonly ReconcileAnswerFact[]): Verdict<{ ids: string[]; facts: ReconcileAnswerFact[] }> {
    const ids = [...new Set(cites)];
    if (ids.length === 0) return refuse('CITES_NO_ANSWER');
    const byId = new Map(answers.map((a) => [a.answerId, a]));
    const facts: ReconcileAnswerFact[] = [];
    for (const id of ids) {
        const fact = byId.get(id);
        if (!fact) return refuse('CITES_FOREIGN_ANSWER');
        if (fact.status !== 'ANSWERED') return refuse('CITES_UNANSWERED');
        facts.push(fact);
    }
    return { ok: true, value: { ids, facts } };
}

/** A field value as plain text, for grounding and display (rich text without markup). */
export function valueAsText(def: FieldDef, value: FieldValue): string {
    if (Array.isArray(value)) return value.join('\n');
    if (typeof value === 'number') return String(value);
    if (def.type === 'richtext') return plainBlock(value.replace(/<\/(p|li|h[1-6]|blockquote)>|<br\s*\/?>/gi, '\n'));
    if (def.type === 'choice') return def.options.find((o) => o.value === value)?.label ?? value;
    return value;
}

/** Plain paragraphs as the HTML a rich-text field stores: one escaped paragraph per blank-line block. */
export function paragraphsToHtml(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p !== '')
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
        .join('');
}

/**
 * Words that name the PRODUCT's own objects, not a story's: a sentence that
 * pairs one of them with an action is an instruction to the product (adv-03
 * "mark every field … complete", adv-07 "copy this entire answer into every
 * field", adv-12 "apply them directly to the bible", adv-13 "cite answer a1"),
 * even when the guard's patterns read it as clean and the cited answer holds
 * it word for word. An order spoken inside a story (adv-14's creed) names no
 * such object. Kept narrow on purpose: a refusal costs the author one
 * suggestion, never their answer.
 */
const PRODUCT_NOUNS: ReadonlySet<string> = new Set(['field', 'fields', 'bible', 'prompt', 'prompts', 'instruction', 'instructions', 'diff', 'proposal', 'proposals', 'chapter', 'chapters', 'workspace', 'json', 'schema']);
const PRODUCT_ACTIONS: ReadonlySet<string> = new Set([
    'mark', 'copy', 'fill', 'replace', 'set', 'apply', 'accept', 'accepted', 'approve', 'approved', 'ignore', 'print', 'reveal', 'rewrite',
    'write', 'cite', 'fetch', 'use', 'report', 'change', 'update', 'delete', 'remove', 'add', 'show', 'paste',
]);

/** Does this text address the product (an action on one of its own objects, or a citation by answer id)? */
export function addressesTheProduct(text: string): boolean {
    for (const sentence of sentences(text)) {
        const w = words(normaliseText(normalizeForScan(sentence)));
        const action = w.some((x) => PRODUCT_ACTIONS.has(x));
        if (!action) continue;
        if (w.some((x) => PRODUCT_NOUNS.has(x) || /^a\d{1,3}$/.test(x))) return true;
    }
    return false;
}

const MARKUP = /<\s*[A-Za-z!/?]/;
const URL_LIKE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const SCRIPT_SCHEME = /\b(?:javascript|data|vbscript)\s*:/i;

/**
 * Rule 5 over the raw strings of a value: markup, a script scheme, a URL that
 * no CLEAN cited answer gives verbatim, or text the 2.1 injection scanner
 * flags. Story text that quotes an in-world order (a spell, a creed) passes
 * when the scanner reads it as clean (`IN_WORLD_TEXT`).
 */
export function copiesInjectedText(parts: readonly string[], cited: readonly ReconcileAnswerFact[]): boolean {
    const cleanSources = cited.filter((a) => a.text !== null && scanInjection(a.text).verdict === 'clean').map((a) => a.text as string);
    for (const part of parts) {
        if (MARKUP.test(part) || SCRIPT_SCHEME.test(part)) return true;
        for (const m of part.matchAll(URL_LIKE)) {
            if (!cleanSources.some((s) => s.includes(m[0]))) return true;
        }
        if (scanInjection(part).verdict !== 'clean') return true;
        if (addressesTheProduct(part)) return true;
    }
    return false;
}

/** Rule 6 for one piece of text: every sentence supported by the sources. */
function groundedText(text: string, sources: readonly string[]): boolean {
    const parts = sentences(text);
    return parts.length > 0 && parts.every((s) => groundSentence(s, sources).supported);
}

/**
 * The value a model gave, read for the field's type: the raw strings (rules 5
 * and 6 read them) and the input `normaliseFieldValue` takes. A rich-text
 * value arrives as plain paragraphs and is stored as escaped HTML; a choice
 * may name an option by its value or its label.
 */
function readValue(def: FieldDef, raw: ReconcileOperation['value']): Verdict<{ parts: string[]; input: unknown }> {
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
            return option ? { ok: true, value: { parts: [option.label], input: option.value } } : refuse('VALUE_INVALID');
        }
        case 'scale':
            return typeof raw === 'number' ? { ok: true, value: { parts: [], input: raw } } : refuse('VALUE_INVALID');
    }
}

/** Rule 6 for a field value. */
function groundedValue(def: FieldDef, value: FieldValue, parts: readonly string[], cited: readonly ReconcileAnswerFact[], stored: FieldValue | null): boolean {
    const sources = cited.map((a) => a.text ?? '').filter((t) => t !== '');
    if (stored !== null) sources.push(valueAsText(def, stored));
    if (def.type === 'scale') {
        // A number is supported by a SCALE answer that gave it, or by the
        // number written as a word in a cited answer.
        return cited.some((a) => a.scale === value) || sources.some((s) => words(normaliseText(s)).includes(String(value)));
    }
    if (def.type === 'list') return parts.every((item) => item.trim() === '' || groundedText(item, sources));
    return parts.every((p) => groundedText(p, sources));
}

/** One field operation through rules 2–6 (rule 1 and duplicates are the caller's). */
export function validateFieldOperation(op: ReconcileOperation, element: ReconcileScopeElement, def: FieldDef, answers: readonly ReconcileAnswerFact[]): Verdict<FieldProposalDraft | null> {
    const stored = element.stored.get(op.fieldKey) ?? null;
    const filled = !isEmpty(stored);
    if (op.op === 'NO_CHANGE') return { ok: true, value: null };
    if (op.op === 'ADD' && filled) return refuse('ADD_INTO_FILLED_FIELD');
    if ((op.op === 'UPDATE' || op.op === 'REMOVE') && !filled) return refuse('CHANGE_OF_EMPTY_FIELD');

    const cites = checkCitations(op.cites, answers);
    if (!cites.ok) return cites;

    if (op.op === 'REMOVE') {
        if (op.value !== null && !(Array.isArray(op.value) && op.value.length === 0) && op.value !== '') return refuse('REMOVE_CARRIES_VALUE');
        return { ok: true, value: { kind: 'FIELD', elementId: element.elementId, fieldKey: op.fieldKey, operation: 'REMOVE', value: null, citedAnswerIds: cites.value.ids } };
    }

    if (op.value === null) return refuse('VALUE_MISSING');
    const read = readValue(def, op.value);
    if (!read.ok) return read;
    const normalised = normaliseFieldValue(def, read.value.input);
    if (!normalised.ok) return refuse('VALUE_INVALID');
    if (normalised.value === null) return refuse('VALUE_MISSING');
    if (op.op === 'UPDATE' && sameFieldValue(stored, normalised.value)) return refuse('CHANGES_NOTHING');
    if (copiesInjectedText(read.value.parts, cites.value.facts)) return refuse('COPIES_INJECTED_TEXT');
    if (!groundedValue(def, normalised.value, read.value.parts, cites.value.facts, op.op === 'UPDATE' ? stored : null)) return refuse('UNSOURCED_SENTENCE');

    return {
        ok: true,
        value: { kind: 'FIELD', elementId: element.elementId, fieldKey: op.fieldKey, operation: op.op, value: normalised.value, citedAnswerIds: cites.value.ids },
    };
}

/** Does `name` occur, as whole words, in `text`? Both normalised (case, look-alikes, format characters). */
export function namedIn(name: string, text: string): boolean {
    const n = words(normaliseText(name));
    const t = words(normaliseText(text));
    if (n.length === 0) return false;
    for (let i = 0; i + n.length <= t.length; i++) if (n.every((w, j) => t[i + j] === w)) return true;
    return false;
}

/** A name compared without case, look-alikes, format characters or a leading article ("The Drainage Board" is "drainage board"). */
export function nameKey(name: string): string {
    const w = words(normaliseText(name));
    return (['the', 'a', 'an'].includes(w[0] ?? '') ? w.slice(1) : w).join(' ');
}

/** A new element through its rules (duplicates and the book's names are checked here; pending proposals at persist). */
export function validateNewElement(item: NewElementOutput, ctx: ValidationContext, seen: Set<string>): Verdict<NewElementDraft> {
    if (!(PROPOSABLE_KINDS as readonly string[]).includes(item.kind)) return refuse('KIND_NOT_PROPOSABLE');
    const name = plainLine(item.name);
    if (name.length === 0 || name.length > NEW_ELEMENT_NAME_MAX) return refuse('NAME_INVALID');
    const cites = checkCitations(item.cites, ctx.answers);
    if (!cites.ok) return cites;
    if (!cites.value.facts.some((a) => a.text !== null && namedIn(name, a.text))) return refuse('NAME_NOT_IN_ANSWERS');
    const key = nameKey(name);
    if (key === '') return refuse('NAME_INVALID');
    if (ctx.bookElementNames.some((n) => nameKey(n) === key)) return refuse('ELEMENT_EXISTS');
    if (seen.has(key)) return refuse('DUPLICATE_NEW_ELEMENT');
    let summary: string | null = null;
    if (item.summary !== null && item.summary.trim() !== '') {
        summary = plainBlock(item.summary);
        if (summary.length > NEW_ELEMENT_SUMMARY_MAX) return refuse('VALUE_INVALID');
        if (copiesInjectedText([item.summary, name], cites.value.facts)) return refuse('COPIES_INJECTED_TEXT');
        const sources = cites.value.facts.map((a) => a.text ?? '');
        if (summary !== '' && !groundedText(summary, sources)) return refuse('UNSOURCED_SENTENCE');
        if (summary === '') summary = null;
    } else if (copiesInjectedText([name], cites.value.facts)) {
        return refuse('COPIES_INJECTED_TEXT');
    }
    seen.add(key);
    return { ok: true, value: { kind: 'NEW_ELEMENT', newKind: item.kind, name, summary, citedAnswerIds: cites.value.ids } };
}

/**
 * Every operation and new element of a parsed output, through the rules. Items
 * that did not parse count as MALFORMED refusals.
 */
export function validateReconcile(parsed: ParsedReconcile, ctx: ValidationContext): ValidationResult {
    const result: ValidationResult = { proposals: [], refusals: [], noChange: 0 };
    for (let i = 0; i < parsed.malformed; i++) result.refusals.push({ code: 'MALFORMED', target: {} });
    const byId = new Map(ctx.elements.map((e) => [e.elementId, e]));
    const done = new Set<string>();
    for (const op of parsed.operations) {
        const target = { elementId: op.elementId, fieldKey: op.fieldKey };
        const element = byId.get(op.elementId);
        const def = element ? getFieldDef(element.kind, op.fieldKey) : undefined;
        if (!element || !def || !element.scopeKeys.includes(op.fieldKey)) {
            result.refusals.push({ code: 'TARGETS_OUT_OF_SCOPE_FIELD', target });
            continue;
        }
        const ref = `${op.elementId}\u0000${op.fieldKey}`;
        if (done.has(ref)) {
            result.refusals.push({ code: 'DUPLICATE_TARGET', target });
            continue;
        }
        done.add(ref);
        const verdict = validateFieldOperation(op, element, def, ctx.answers);
        if (!verdict.ok) result.refusals.push({ code: verdict.code, target });
        else if (verdict.value === null) result.noChange++;
        else result.proposals.push(verdict.value);
    }
    const seen = new Set<string>();
    for (const item of parsed.newElements) {
        const verdict = validateNewElement(item, ctx, seen);
        if (verdict.ok) result.proposals.push(verdict.value);
        else result.refusals.push({ code: verdict.code, target: { kind: item.kind } });
    }
    return result;
}

/** Refusals by code, for a run's metrics (codes and counts, never text). */
export function refusalCounts(refusals: readonly Refusal[]): Partial<Record<RefusalCode, number>> {
    const out: Partial<Record<RefusalCode, number>> = {};
    for (const r of refusals) out[r.code] = (out[r.code] ?? 0) + 1;
    return out;
}
