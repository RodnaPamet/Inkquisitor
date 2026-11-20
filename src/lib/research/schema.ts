/**
 * The research agent's two structured outputs (Phase 2.6) and the
 * item-by-item readers code uses on whatever the model returned.
 *
 * Both schemas are CODE (2.1: the API caches a compiled schema outside the
 * zero-retention scope; nothing here is built from author text or a page) and
 * stay within 2.1's structured-output limits: every member required, the
 * nullable members few. The answer is untrusted: each item is re-read on its
 * own, so one malformed item costs only itself, and `validate.ts` holds every
 * survivor to the rules.
 */
import { z } from 'zod';
import { BIBLE_KINDS, IDENTIFIER_MAX, IDENTIFIER_PATTERN } from '@/lib/bible/kinds';
import { QUOTE_MAX_CHARS } from './sources';
import { CONFIDENCES, RESEARCH_OPS } from './vocabulary';

/** Findings one call may return (past the depth's own limit they are refused OVER_LIMIT). */
export const FINDINGS_PER_CALL_MAX = 24;
export const CITATIONS_PER_FINDING_MAX = 4;
export const CLAIM_RAW_MAX = 1_200;
export const SUMMARY_RAW_MAX = 4_000;
/** Stored bounds, after sanitising. */
export const CLAIM_MAX = 600;
export const SUMMARY_MAX = 2_400;
export const NO_FIT_REASON_MAX = 400;
export const RATIONALE_MAX = 800;

export const PROPOSALS_PER_CALL_MAX = 30;
export const NO_FIT_PER_CALL_MAX = 24;
export const FIT_CITES_MAX = 8;
export const VALUE_TEXT_RAW_MAX = 8_000;
export const VALUE_ITEMS_MAX = 40;
export const VALUE_ITEM_RAW_MAX = 1_000;
export const NEW_NAME_RAW_MAX = 240;
export const NEW_SUMMARY_RAW_MAX = 2_000;
export const RATIONALE_RAW_MAX = 1_600;
export const NO_FIT_REASON_RAW_MAX = 800;

/** A finding's ref in the fit prompt: `f1`, `f2`, … (its position, 1-based). */
export const FINDING_REF_PATTERN = /^f[1-9]\d{0,2}$/;
/** A source's ref in the findings prompt. */
export const SOURCE_REF_PATTERN = /^(web|file)\.[1-9]\d{0,2}$/;

/** Kinds the fit step may propose as a new element: every kind but CUSTOM, which needs a label of the author's. */
export const RESEARCH_PROPOSABLE_KINDS = BIBLE_KINDS.filter((k) => k !== 'CUSTOM');

export const CitationOutputSchema = z.object({ ref: z.string().max(16), quote: z.string().max(QUOTE_MAX_CHARS) }).strict();

export const FindingOutputSchema = z
    .object({
        claim: z.string().max(CLAIM_RAW_MAX),
        summary: z.string().max(SUMMARY_RAW_MAX),
        confidence: z.enum(CONFIDENCES),
        citations: z.array(CitationOutputSchema).max(CITATIONS_PER_FINDING_MAX),
    })
    .strict();
export type FindingOutput = z.infer<typeof FindingOutputSchema>;

export const FindingsOutputSchema = z.object({ findings: z.array(FindingOutputSchema).max(FINDINGS_PER_CALL_MAX) }).strict();

const fieldKey = z.string().max(IDENTIFIER_MAX).regex(IDENTIFIER_PATTERN);

/**
 * One proposal. ADD / UPDATE: `elementId`, `fieldKey`, `value` (text for text,
 * rich text — plain paragraphs — and choice fields; items for a list; 1..5 for
 * a scale), the new-element members null. NEW_ELEMENT: `newKind`, `newName`,
 * `newSummary`, the field members null.
 */
export const FitProposalOutputSchema = z
    .object({
        op: z.enum(RESEARCH_OPS),
        elementId: z.string().max(64).nullable(),
        fieldKey: fieldKey.nullable(),
        value: z.union([z.string().max(VALUE_TEXT_RAW_MAX), z.array(z.string().max(VALUE_ITEM_RAW_MAX)).max(VALUE_ITEMS_MAX), z.number().int(), z.null()]),
        newKind: z.enum(BIBLE_KINDS).nullable(),
        newName: z.string().max(NEW_NAME_RAW_MAX).nullable(),
        newSummary: z.string().max(NEW_SUMMARY_RAW_MAX).nullable(),
        rationale: z.string().max(RATIONALE_RAW_MAX),
        cites: z.array(z.string().max(8)).max(FIT_CITES_MAX),
    })
    .strict();
export type FitProposalOutput = z.infer<typeof FitProposalOutputSchema>;

export const NoFitOutputSchema = z.object({ finding: z.string().max(8), reason: z.string().max(NO_FIT_REASON_RAW_MAX) }).strict();
export type NoFitOutput = z.infer<typeof NoFitOutputSchema>;

export const FitOutputSchema = z
    .object({
        proposals: z.array(FitProposalOutputSchema).max(PROPOSALS_PER_CALL_MAX),
        noFit: z.array(NoFitOutputSchema).max(NO_FIT_PER_CALL_MAX),
    })
    .strict();

function readItems<T>(raw: unknown, schema: z.ZodType<T>, max: number, out: { malformed: number }): T[] {
    if (!Array.isArray(raw)) return [];
    const items: T[] = [];
    out.malformed += Math.max(0, raw.length - max);
    for (const item of raw.slice(0, max)) {
        const parsed = schema.safeParse(item);
        if (parsed.success) items.push(parsed.data);
        else out.malformed++;
    }
    return items;
}

export interface ParsedFindings {
    findings: FindingOutput[];
    malformed: number;
    unreadable: boolean;
}

export function parseFindingsOutput(raw: unknown): ParsedFindings {
    const out: ParsedFindings = { findings: [], malformed: 0, unreadable: false };
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { findings?: unknown }).findings)) {
        out.unreadable = true;
        return out;
    }
    out.findings = readItems((raw as { findings: unknown }).findings, FindingOutputSchema, FINDINGS_PER_CALL_MAX, out);
    return out;
}

export interface ParsedFit {
    proposals: FitProposalOutput[];
    noFit: NoFitOutput[];
    malformed: number;
    unreadable: boolean;
}

export function parseFitOutput(raw: unknown): ParsedFit {
    const out: ParsedFit = { proposals: [], noFit: [], malformed: 0, unreadable: false };
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { proposals?: unknown }).proposals)) {
        out.unreadable = true;
        return out;
    }
    const r = raw as { proposals: unknown; noFit?: unknown };
    out.proposals = readItems(r.proposals, FitProposalOutputSchema, PROPOSALS_PER_CALL_MAX, out);
    out.noFit = readItems(r.noFit, NoFitOutputSchema, NO_FIT_PER_CALL_MAX, out);
    return out;
}
