/**
 * A finding's DETAIL as stored (Phase 5.2, D34): its message parameters and
 * its deterministic suggestion, as one JSON string the field-encryption
 * extension seals (`ProseFinding.detail` is in the encrypted manifest: the
 * parameters are words of the scene or of the style sheet). Every string goes
 * through `plainLine` (`sanitizePlainText`) and is bounded; numbers must be
 * finite; the shape is bounded. Read back through `parseFindingDetail`, which
 * answers an empty detail for anything that does not read.
 */
import { z } from 'zod';
import { plainLine } from '@/lib/bible/text';
import type { DraftSuggestion } from './rules/types';

/** Characters a parameter or a replacement keeps at most. */
export const DETAIL_STRING_MAX = 200;
/** Parameters a finding carries at most. */
export const DETAIL_PARAMS_MAX = 8;

export interface FindingDetail {
    params: Record<string, string | number>;
    suggestion: DraftSuggestion | null;
}

const KEY = /^[a-zA-Z]{1,24}$/;

function cleanDetailString(s: string): string {
    const v = plainLine(s.slice(0, DETAIL_STRING_MAX * 4));
    return v.length > DETAIL_STRING_MAX ? v.slice(0, DETAIL_STRING_MAX) : v;
}

/** The detail as stored: sanitised, bounded, JSON. */
export function sanitiseFindingDetail(detail: FindingDetail): string {
    const params: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(detail.params).slice(0, DETAIL_PARAMS_MAX)) {
        if (!KEY.test(k)) continue;
        if (typeof v === 'number') {
            if (Number.isFinite(v)) params[k] = v;
        } else if (typeof v === 'string') params[k] = cleanDetailString(v);
    }
    const s = detail.suggestion;
    const suggestion =
        s && Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.end > s.start ? { start: s.start, end: s.end, replacement: cleanDetailString(s.replacement) } : null;
    return JSON.stringify({ params, suggestion });
}

const StoredDetail = z
    .object({
        params: z.record(z.string().regex(KEY), z.union([z.string().max(DETAIL_STRING_MAX), z.number().finite()])),
        suggestion: z.object({ start: z.number().int().min(0), end: z.number().int().min(1), replacement: z.string().max(DETAIL_STRING_MAX) }).strict().nullable(),
    })
    .strict();

export function parseFindingDetail(raw: string): FindingDetail {
    try {
        const parsed = StoredDetail.safeParse(JSON.parse(raw));
        if (parsed.success && Object.keys(parsed.data.params).length <= DETAIL_PARAMS_MAX) return parsed.data;
    } catch {
        // fall through
    }
    return { params: {}, suggestion: null };
}
