/**
 * The gap hunt's author-derived text as it is STORED (Phase 4.3, D29): the
 * picks' reasons are model text about the book, so the picks are one JSON
 * string, sanitised and bounded here and encrypted by the extension
 * (`src/lib/security/encrypted-fields.ts`). Candidates are product words and
 * counts and are stored plainly.
 */
import { plainLine } from '@/lib/bible/text';
import { GAP_CITES_MAX, GAP_PICKS_MAX, GAP_REASON_MAX, type GapPick } from './vocabulary';

export function sanitiseGapPicksForStorage(picks: readonly GapPick[]): string {
    return JSON.stringify(
        picks.slice(0, GAP_PICKS_MAX).map((p) => {
            const reason = p.reason === null ? null : plainLine(p.reason).slice(0, GAP_REASON_MAX) || null;
            return { n: p.n, reason, cites: p.cites.slice(0, GAP_CITES_MAX), flags: p.flags.filter((f) => f === 'POSSIBLE_INSTRUCTION') };
        }),
    );
}

export function decodeGapPicks(stored: string): GapPick[] {
    try {
        const v = JSON.parse(stored) as unknown;
        if (!Array.isArray(v)) return [];
        return v.flatMap((p) => {
            const o = p as { n?: unknown; reason?: unknown; cites?: unknown; flags?: unknown };
            if (typeof o.n !== 'number') return [];
            return [{ n: o.n, reason: typeof o.reason === 'string' ? o.reason : null, cites: Array.isArray(o.cites) ? o.cites.filter((x): x is number => typeof x === 'number') : [], flags: Array.isArray(o.flags) ? o.flags.filter((x): x is string => typeof x === 'string') : [] }];
        });
    } catch {
        return [];
    }
}
