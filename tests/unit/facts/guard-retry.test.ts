/**
 * Refused sections are retried on a safety update (Phase 4.H-b, D32): which
 * sections a version sends again under a newer guard, which refusals it carries
 * forward, and what it records. Pure.
 */
import { guardRetryPlan, refusalsToRecord } from '@/lib/facts/guard-retry';
import { readGuardRefused } from '@/lib/facts/vocabulary';
import { callPurposeOf } from '@/lib/ai/call-structured';
import { BIBLE_FACTS_PROMPT } from '@/lib/facts/prompt';
import { BIBLE_FACTS_BACKFILL_PURPOSE } from '@/lib/facts/model-seam';

const section = (key: string, text = `${key} text`) => ({ key, label: key, text });
const body = [section('summary'), section('want'), section('wound'), section('fear')];

describe('the retry plan', () => {
    it('re-sends a section refused under OLDER rules once, beside the changed ones; carries one refused under the current rules', () => {
        const plan = guardRetryPlan({ body, changed: [section('summary')], baselineRefused: [{ key: 'want', rulesVersion: 1 }, { key: 'wound', rulesVersion: 2 }], rulesVersion: 2 });
        expect(plan.send.map((s) => s.key)).toEqual(['summary', 'want']);
        expect(plan.retried).toEqual(['want']);
        expect(plan.carried).toEqual([{ key: 'wound', rulesVersion: 2 }]);
    });

    it('a changed refused section is sent as changed (never twice), and one no longer in the entry is dropped', () => {
        const plan = guardRetryPlan({ body: body.filter((s) => s.key !== 'fear'), changed: [section('want')], baselineRefused: [{ key: 'want', rulesVersion: 1 }, { key: 'fear', rulesVersion: 1 }], rulesVersion: 2 });
        expect(plan.send.map((s) => s.key)).toEqual(['want']);
        expect(plan.retried).toEqual([]);
        expect(plan.carried).toEqual([]);
    });

    it('records the carried refusals and every section of a refused call under the current rules; nothing refused is NULL', () => {
        expect(refusalsToRecord([{ key: 'wound', rulesVersion: 2 }], ['want', 'wound'], 3)).toEqual([{ key: 'wound', rulesVersion: 3 }, { key: 'want', rulesVersion: 3 }]);
        expect(refusalsToRecord([], [], 3)).toBeNull();
    });

    it('a stored record is read defensively: anything malformed is dropped (it can only re-send less)', () => {
        expect(readGuardRefused([{ key: 'want', rulesVersion: 1 }, { key: 'Bad Key', rulesVersion: 1 }, { key: 'x', rulesVersion: 0 }, 'junk', null])).toEqual([{ key: 'want', rulesVersion: 1 }]);
        expect(readGuardRefused(null)).toEqual([]);
    });
});

describe('a call\'s purpose (the backfill\'s sub-purpose, D32)', () => {
    it('is the template\'s, or a sub-purpose of it; anything else is refused before a call', () => {
        expect(callPurposeOf(BIBLE_FACTS_PROMPT, undefined)).toBe(BIBLE_FACTS_PROMPT.purpose);
        expect(callPurposeOf(BIBLE_FACTS_PROMPT, BIBLE_FACTS_BACKFILL_PURPOSE)).toBe('facts.bible-extract.backfill');
        expect(() => callPurposeOf(BIBLE_FACTS_PROMPT, 'continuity.deep-check')).toThrow();
        expect(() => callPurposeOf(BIBLE_FACTS_PROMPT, `${BIBLE_FACTS_PROMPT.purpose}.Bad Label`)).toThrow();
    });
});
