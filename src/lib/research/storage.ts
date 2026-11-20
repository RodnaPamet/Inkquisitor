/**
 * The research write path's sanitisers (Phase 2.6): every encrypted column of
 * the research tables passes one of these at the usecase layer before it is
 * stored (`tests/guards/encrypted-field-sanitiser-coverage.test.ts` holds each
 * writer to it). Raw input is bounded before it is sanitised.
 */
import { encodeFieldValue, normaliseFieldValue, type FieldValue } from '@/lib/bible/field-values';
import type { BibleKind } from '@/lib/bible/kinds';
import { getFieldDef } from '@/lib/bible/templates';
import { plainBlock, plainLine } from '@/lib/bible/text';
import { CLAIM_MAX, NO_FIT_REASON_MAX, RATIONALE_MAX, SUMMARY_MAX } from './schema';
import { QUOTE_MAX_CHARS, SOURCE_TEXT_MAX_CHARS } from './sources';
import type { FindingDraft, FitDraft } from './validate';
import { NEW_ELEMENT_NAME_MAX, NEW_ELEMENT_SUMMARY_MAX } from './validate';

export const QUESTION_MAX = 600;
export const PURPOSE_MAX = 600;
export const URL_MAX = 2_000;
export const URLS_MAX = 8;
export const FILENAME_MAX = 200;
export const TITLE_MAX = 300;
/** A query or fetch URL as a run's egress list stores it (D15). */
export const EGRESS_TEXT_MAX = 2_000;

export class ResearchTextNotStorableError extends Error {
    constructor(readonly what: string) {
        super(`research text not storable: ${what}`);
        this.name = 'ResearchTextNotStorableError';
    }
}

/** Raw input bounded before it is sanitised (at most four times the stored bound). */
const bounded = (raw: string, max: number) => raw.slice(0, max * 4);

/** Sanitised text, cut to its bound; refused when nothing is left. */
function required(sanitised: string, max: number, what: string): string {
    const v = sanitised.slice(0, max).trim();
    if (!v) throw new ResearchTextNotStorableError(what);
    return v;
}

/** A brief's question, purpose and URLs as stored (URLs already parsed by the usecase). */
export function sanitiseBriefForStorage(input: { question: string; purpose: string; urls: readonly string[] }): { question: string; purpose: string; sourceUrls: string | null } {
    const urls = input.urls.slice(0, URLS_MAX).map((u) => plainLine(u.slice(0, URL_MAX))).filter((u) => u !== '');
    return {
        question: required(plainBlock(bounded(input.question, QUESTION_MAX)), QUESTION_MAX, 'question'),
        purpose: required(plainBlock(bounded(input.purpose, PURPOSE_MAX)), PURPOSE_MAX, 'purpose'),
        sourceUrls: urls.length > 0 ? JSON.stringify(urls) : null,
    };
}

/** The URLs a stored brief carries. */
export function decodeSourceUrls(stored: string | null): string[] {
    if (!stored) return [];
    try {
        const parsed: unknown = JSON.parse(stored);
        return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
    } catch {
        return [];
    }
}

/** An attached file as stored: its name and its text. */
export function sanitiseSourceForStorage(input: { filename: string; text: string }): { filename: string; text: string } {
    return {
        filename: required(plainLine(bounded(input.filename, FILENAME_MAX)), FILENAME_MAX, 'filename'),
        text: required(plainBlock(bounded(input.text, SOURCE_TEXT_MAX_CHARS)), SOURCE_TEXT_MAX_CHARS, 'text'),
    };
}

export interface StoredFindingText {
    claim: string;
    summary: string;
    noFitReason: string | null;
    citations: Array<{ kind: 'URL' | 'UPLOAD'; url: string | null; sourceId: string | null; title: string | null; quotedSpan: string; retrievedAt: Date | null }>;
}

/** A verified finding as stored (sanitised again: belt and braces over `validate.ts`). */
export function sanitiseFindingForStorage(f: FindingDraft, noFitReason: string | null): StoredFindingText {
    return {
        claim: required(plainBlock(bounded(f.claim, CLAIM_MAX)), CLAIM_MAX, 'claim'),
        summary: required(plainBlock(bounded(f.summary, SUMMARY_MAX)), SUMMARY_MAX, 'summary'),
        noFitReason: noFitReason ? plainBlock(noFitReason).slice(0, NO_FIT_REASON_MAX).trim() || null : null,
        citations: f.citations.map((c) => {
            const retrieved = c.retrievedAt ? new Date(c.retrievedAt) : null;
            return {
                kind: c.kind,
                url: c.url ? plainLine(c.url.slice(0, URL_MAX)) : null,
                sourceId: c.sourceId,
                title: c.title ? plainLine(c.title).slice(0, TITLE_MAX) || null : null,
                quotedSpan: required(plainBlock(bounded(c.quotedSpan, QUOTE_MAX_CHARS)), QUOTE_MAX_CHARS, 'quote'),
                retrievedAt: retrieved && !Number.isNaN(retrieved.getTime()) ? retrieved : null,
            };
        }),
    };
}

export interface StoredProposalText {
    proposedValue: string | null;
    newName: string | null;
    newSummary: string | null;
    rationale: string;
}

/** A validated proposal as stored: the value through the field's own check again, the rest as plain text. */
export function sanitiseResearchProposalForStorage(p: FitDraft): StoredProposalText {
    const rationale = required(plainBlock(bounded(p.rationale, RATIONALE_MAX)), RATIONALE_MAX, 'rationale');
    if (p.operation === 'NEW_ELEMENT') {
        const summary = p.newSummary ? plainBlock(p.newSummary).slice(0, NEW_ELEMENT_SUMMARY_MAX).trim() : '';
        return { proposedValue: null, newName: required(plainLine(bounded(p.newName, NEW_ELEMENT_NAME_MAX)), NEW_ELEMENT_NAME_MAX, 'name'), newSummary: summary || null, rationale };
    }
    const def = getFieldDef(p.elementKind as BibleKind, p.fieldKey);
    if (!def) throw new ResearchTextNotStorableError('field');
    const normalised = normaliseFieldValue(def, p.value);
    if (!normalised.ok || normalised.value === null) throw new ResearchTextNotStorableError('value');
    return { proposedValue: encodeFieldValue(normalised.value), newName: null, newSummary: null, rationale };
}

/** A stored proposal value back to a field value. */
export function decodeResearchValue(stored: string | null): FieldValue | null {
    if (stored === null) return null;
    try {
        const parsed: unknown = JSON.parse(stored);
        if (typeof parsed === 'string' || typeof parsed === 'number') return parsed;
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) return parsed as string[];
        return null;
    } catch {
        return null;
    }
}

/**
 * One query or fetch URL a run sent, as stored (decision D15): plain text,
 * bounded. An input that was not a string (the tripwire refused it unread) is
 * stored as its JSON, so the list still shows that something was asked.
 */
export function sanitiseEgressForStorage(input: unknown): string {
    const raw = typeof input === 'string' ? input : (JSON.stringify(input ?? null) ?? 'null');
    return plainLine(bounded(raw, EGRESS_TEXT_MAX)).slice(0, EGRESS_TEXT_MAX);
}
