/**
 * THE QUESTION GENERATORS (Phase 4.4, D23 and D30). Pure: no database, no
 * clock, no network — the usecase loads every input first
 * (`src/app-layer/usecases/interview-generators.ts`) and the round's plan is
 * made from what comes back (`selectCandidates`, `select.ts`).
 *
 * The frontier (2.2) is ONE generator among several. Each proposes CANDIDATES:
 * a subject's field to ask about (or, for a source question, a fact to decide),
 * with a VALUE SCORE (`value.ts`) and, unless the model words it, its question
 * already worded by code (`wording.ts`). Code then validates, deduplicates and
 * orders every candidate whichever generator proposed it, best value first.
 *
 *   FRONTIER    2.2's frontier: every open field whose prerequisites are settled, within the depth; the model
 *               words it (QUESTION_PROMPT, unchanged), the pack fallback behind it
 *   LADDER      follow-ups on a field this session or the bible already answers, layer by layer (what, why, what
 *               it costs, who knows, what breaks it, edge cases); the depth dial sets how far down a session goes
 *               (`ladderDepthFor`). A layer is asked only while no answer holds it: one ANSWERED anywhere in the book
 *               holds it for good, one asked in this session (answered or not) holds it for the session (rule 5), and
 *               a layer waits for the one above it. Prose fields only (text, rich text): its answer deepens that
 *               field through reconcile (an UPDATE or ADD of the field it follows up)
 *   RELATIONS   an existing relation's empty fields (a frontier entry on the relation, as 3.3 asks a selection's)
 *               and PAIRS of the scope's characters and factions with no relation yet ("What does Wren want from
 *               the Harbourmaster?"), at most `PAIRS_PER_ROUND_MAX` a round; a pair's answer may lead reconcile to
 *               propose a NEW_RELATION, which the author accepts or rejects as ever
 *   SOURCES     a PENDING, unflagged fact of the book's own source set about an element in scope, quoted; yes
 *               confirms it and no rejects it when the round closes, exactly as the Facts page would (D30, item 2).
 *               It targets the field the fact answers (`PREDICATE_FIELDS`), or none when its predicate answers none
 *   CONTINUITY  4.2's pending contradictions (the field the facts disagree about), open threads (an unpaid promise,
 *               an unfound clue, an open question, landing in the field that tracks them) and timeline gaps (an
 *               event with no story time between two placed events that have one)
 *
 * A generator the author switched off proposes nothing (`enabled`). Questions only ever fill template fields or
 * relation fields, or decide facts: a candidate with nowhere to land is never made.
 */
import type { BibleKind } from '@/lib/bible/kinds';
import type { FieldDef } from '@/lib/bible/template-schema';
import { kindsAllowed } from '../dials';
import { refKey, type FieldRef, type FrontierResult } from '../frontier';
import { pairSubjectId, type PendingSubject, type RelationSubject } from '../subjects';
import { LADDER_LAYERS, PAIR_ANGLES, type LadderLayer, type PairAngle, type QuestionGeneratorKey } from '../vocabulary';
import { ladderDepthFor } from './ladder-depth';
import { CONTINUITY_VALUE, PAIR_VALUE, clampValue, frontierValue, ladderValue, sourceValue } from './value';
import { PAIR_ANGLE_FIELD, contradictionQuestion, ladderQuestion, pairQuestion, sourceQuestion, threadQuestion, timelineGapQuestion, type WordedQuestion } from './wording';

/** A subject of the session's scope, as the generators read it (the round's `RoundElement`, structurally). */
export interface GeneratorSubject {
    elementId: string;
    kind: BibleKind;
    name: string;
    fields: readonly FieldDef[];
    storedText: ReadonlyMap<string, string>;
    relation?: RelationSubject;
    pending?: PendingSubject;
    /** A relation the RELATIONS generator brought into a non-selection scope (both its ends in scope). */
    addedByRelations?: boolean;
}

/** One candidate question (the header). */
export interface TargetCandidate {
    generator: QuestionGeneratorKey;
    /** The subject: an element, a relation, the pending element, or a pair (`pairSubjectId`). */
    elementId: string;
    /** The field it fills or follows up; null for a source question whose fact answers no field. */
    fieldKey: string | null;
    level: number;
    required: boolean;
    /** 0..100 (`value.ts`). */
    value: number;
    /** The question as code worded it; null: the model words it (the frontier, a relation's empty field). */
    worded: WordedQuestion | null;
    /** A ladder layer or a pair angle. */
    angle?: LadderLayer | PairAngle;
    /** A pair's second element (the first is the pair subject's). */
    pairElementId?: string;
    /** A source question's fact. */
    storyFactId?: string;
    /** A continuity question's basis: `proposal:<id>`, `thread:<id>`, `gap:<elementId>`. */
    continuityRef?: string;
}

/** Ladder layers already held: `subject\0field\0layer` keys. */
export interface LadderHistory {
    /** Answered (ANSWERED) in any session of the book. */
    answered: ReadonlySet<string>;
    /** Asked in THIS session, whatever became of it. */
    askedInSession: ReadonlySet<string>;
}

export function ladderKey(subjectId: string, fieldKey: string, layer: string): string {
    return `${subjectId}\u0000${fieldKey}\u0000${layer}`;
}

/** Two elements of the scope with no relation between them (the usecase found them, bounded). */
export interface PairInput {
    firstElementId: string;
    secondElementId: string;
    firstName: string;
    secondName: string;
    /** Angles answered anywhere in the book, and asked in this session. */
    answered: ReadonlySet<PairAngle>;
    askedInSession: ReadonlySet<PairAngle>;
}

/** A pending, unflagged fact of the book's source set about an element in scope. */
export interface PendingFactInput {
    factId: string;
    subjectElementId: string;
    /** The field its predicate answers on that element (`fieldAnsweredBy`), or null. */
    fieldKey: string | null;
    quote: string;
    sourceName: string;
    /** Where in the source (its nearest heading), or null. */
    where: string | null;
}

export type ContinuityInput =
    | { type: 'CONTRADICTION'; proposalId: string; subjectElementId: string; fieldKey: string; olderQuote: string; newerQuote: string }
    | { type: 'THREAD'; threadId: string; threadKind: 'PROMISE' | 'CLUE' | 'OPEN_QUESTION'; subjectElementId: string; fieldKey: string; title: string }
    | { type: 'TIMELINE_GAP'; elementId: string; fieldKey: string; before: { name: string; time: string }; after: { name: string; time: string } };

export interface GeneratorInput {
    depth: number;
    detail: number;
    /** The generators on for this session (the dial, `generatorsOff` subtracted). */
    enabled: ReadonlySet<QuestionGeneratorKey>;
    subjects: readonly GeneratorSubject[];
    /** 2.2's frontier over the subjects, computed already (rule 5 applied). */
    frontier: FrontierResult;
    ladder: LadderHistory;
    /** Live facts (bible and confirmed source facts) already held per field (`refKey`): the ladder's value reads them. */
    factsHeld: ReadonlyMap<string, number>;
    pairs: readonly PairInput[];
    pendingFacts: readonly PendingFactInput[];
    continuity: readonly ContinuityInput[];
}

export { ladderDepthFor };

/** The field types the ladder follows up: prose, which a deeper answer can extend. */
const LADDER_FIELD_TYPES: ReadonlySet<string> = new Set(['text', 'richtext']);

/** How many fields of the subject wait on `key`. */
function dependantsOf(fields: readonly FieldDef[], key: string): number {
    return fields.filter((f) => f.dependsOn.includes(key)).length;
}

function frontierCandidates(input: GeneratorInput): TargetCandidate[] {
    const subjects = new Map(input.subjects.map((s) => [s.elementId, s] as const));
    const out: TargetCandidate[] = [];
    for (const f of input.frontier.frontier) {
        const subject = subjects.get(f.elementId);
        if (!subject) continue;
        const generator: QuestionGeneratorKey = subject.addedByRelations ? 'RELATIONS' : 'FRONTIER';
        if (!input.enabled.has(generator)) continue;
        out.push({
            generator,
            elementId: f.elementId,
            fieldKey: f.fieldKey,
            level: f.level,
            required: f.required,
            value: frontierValue({ required: f.required, level: f.level, dependants: dependantsOf(subject.fields, f.fieldKey) }),
            worded: null,
        });
    }
    return out;
}

function ladderCandidates(input: GeneratorInput): TargetCandidate[] {
    if (!input.enabled.has('LADDER') || !kindsAllowed(input.detail).includes('OPEN')) return [];
    const layers = LADDER_LAYERS.slice(0, ladderDepthFor(input.depth));
    const satisfied = new Set([...input.frontier.answered.map(refKey), ...input.frontier.answeredInSession.map(refKey)]);
    const levelOf = new Map([...input.frontier.answered.map((a) => [refKey(a), a.level] as const)]);
    const out: TargetCandidate[] = [];
    for (const subject of input.subjects) {
        if (subject.pending) continue;
        for (const field of subject.fields) {
            if (!LADDER_FIELD_TYPES.has(field.type)) continue;
            const ref: FieldRef = { elementId: subject.elementId, fieldKey: field.key };
            if (!satisfied.has(refKey(ref))) continue;
            const level = levelOf.get(refKey(ref)) ?? 1;
            if (level > input.depth) continue;
            // Layer by layer: the first layer no answer holds, unless this session already asked it (then the field waits).
            const next = layers.find((l) => !input.ladder.answered.has(ladderKey(subject.elementId, field.key, l)));
            if (!next || input.ladder.askedInSession.has(ladderKey(subject.elementId, field.key, next))) continue;
            const ladderSubject = subject.relation ? { kind: 'relation' as const, fromName: subject.relation.fromName, toName: subject.relation.toName } : { kind: 'element' as const, name: subject.name };
            out.push({
                generator: 'LADDER',
                elementId: subject.elementId,
                fieldKey: field.key,
                level,
                required: field.required,
                value: ladderValue(next, { required: field.required, factsHeld: input.factsHeld.get(refKey(ref)) ?? 0 }),
                worded: ladderQuestion(next, ladderSubject, field.label),
                angle: next,
            });
        }
    }
    return out;
}

function pairCandidates(input: GeneratorInput): TargetCandidate[] {
    if (!input.enabled.has('RELATIONS') || !kindsAllowed(input.detail).includes('OPEN')) return [];
    const out: TargetCandidate[] = [];
    for (const p of input.pairs) {
        for (const angle of PAIR_ANGLES) {
            if (p.answered.has(angle) || p.askedInSession.has(angle)) continue;
            // What is hidden is asked once what each wants is known.
            if (angle === 'HIDDEN' && !p.answered.has('WANTS')) continue;
            out.push({
                generator: 'RELATIONS',
                elementId: pairSubjectId(p.firstElementId, p.secondElementId),
                fieldKey: PAIR_ANGLE_FIELD[angle],
                level: 1,
                required: false,
                value: clampValue(PAIR_VALUE[angle]),
                worded: pairQuestion(angle, p.firstName, p.secondName),
                angle,
                pairElementId: p.secondElementId,
            });
        }
    }
    return out;
}

function sourceCandidates(input: GeneratorInput): TargetCandidate[] {
    if (!input.enabled.has('SOURCES')) return [];
    const subjects = new Map(input.subjects.map((s) => [s.elementId, s] as const));
    const out: TargetCandidate[] = [];
    for (const f of input.pendingFacts) {
        const subject = subjects.get(f.subjectElementId);
        if (!subject || subject.relation || subject.pending) continue;
        const field = f.fieldKey ? subject.fields.find((x) => x.key === f.fieldKey) : undefined;
        out.push({
            generator: 'SOURCES',
            elementId: subject.elementId,
            fieldKey: field ? field.key : null,
            level: 1,
            required: field?.required ?? false,
            value: sourceValue(field ? subject.storedText.has(field.key) : false),
            worded: sourceQuestion(f.quote, f.sourceName, f.where),
            storyFactId: f.factId,
        });
    }
    return out;
}

function continuityCandidates(input: GeneratorInput): TargetCandidate[] {
    if (!input.enabled.has('CONTINUITY') || !kindsAllowed(input.detail).includes('OPEN')) return [];
    const subjects = new Map(input.subjects.map((s) => [s.elementId, s] as const));
    const out: TargetCandidate[] = [];
    for (const c of input.continuity) {
        const subjectId = c.type === 'TIMELINE_GAP' ? c.elementId : c.subjectElementId;
        const subject = subjects.get(subjectId);
        if (!subject || subject.relation || subject.pending) continue;
        const field = subject.fields.find((x) => x.key === c.fieldKey);
        if (!field) continue;
        const base = { generator: 'CONTINUITY' as const, elementId: subject.elementId, fieldKey: field.key, level: 1, required: field.required };
        if (c.type === 'CONTRADICTION') {
            out.push({ ...base, value: CONTINUITY_VALUE.CONTRADICTION, worded: contradictionQuestion(subject.name, c.olderQuote, c.newerQuote), continuityRef: `proposal:${c.proposalId}` });
        } else if (c.type === 'THREAD') {
            out.push({ ...base, value: CONTINUITY_VALUE.THREAD, worded: threadQuestion(c.threadKind, c.title), continuityRef: `thread:${c.threadId}` });
        } else {
            out.push({ ...base, value: CONTINUITY_VALUE.TIMELINE_GAP, worded: timelineGapQuestion(subject.name, c.before, c.after), continuityRef: `gap:${c.elementId}` });
        }
    }
    return out;
}

/** Every generator's candidates, in generator order (the frontier first, in frontier order). Selection orders them by value. */
export function generateCandidates(input: GeneratorInput): TargetCandidate[] {
    return [...frontierCandidates(input), ...sourceCandidates(input), ...continuityCandidates(input), ...ladderCandidates(input), ...pairCandidates(input)];
}
