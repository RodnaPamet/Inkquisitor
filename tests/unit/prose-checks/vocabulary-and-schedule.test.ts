/**
 * The prose checks' vocabulary, words and queue (Phase 5.2, D34): every rule
 * and refusal is worded, the inclusive-language check is the only one off by
 * default, a save's check is debounced by the queue's per-scene deduplication,
 * and the per-workspace minute puts a check back rather than run it.
 */
import en from '../../../messages/en.json';
import { proseCheckDedupId, scheduleProseCheck } from '@/app-layer/usecases/prose-check-schedule';
import { chargeProseCheckRun } from '@/lib/security/prose-check-rate-limit';
import { PROSE_CHECK_DEBOUNCE_MS, PROSE_CHECK_REASONS, PROSE_RULES, PROSE_RULE_IDS, TOGGLEABLE_RULE_IDS, readabilityBand, READABILITY_BANDS } from '@/lib/prose-checks/vocabulary';

const words = en.manuscript.proseChecks;

describe('the vocabulary', () => {
    it('words every rule (name, what it reads, its message) and every refusal', () => {
        for (const id of PROSE_RULE_IDS) {
            const r = (words.rules as Record<string, { name: string; about: string; message: string }>)[id];
            expect(r?.name && r.about && r.message).toBeTruthy();
        }
        expect(Object.keys(words.rules).sort()).toEqual([...PROSE_RULE_IDS].sort());
        expect(Object.keys(words.reasons).sort()).toEqual([...PROSE_CHECK_REASONS].sort());
        expect(Object.keys(words.bands).sort()).toEqual([...READABILITY_BANDS].sort());
    });
    it('keeps only the inclusive-language check off by default, out of the toggles (its own switch)', () => {
        expect(PROSE_RULE_IDS.filter((id) => PROSE_RULES[id].defaultOff)).toEqual(['inclusive-language']);
        expect(TOGGLEABLE_RULE_IDS).not.toContain('inclusive-language');
        expect(PROSE_RULES['inclusive-language'].scope).toBe('NARRATION');
    });
    it('bands a reading-ease score and never judges it', () => {
        expect([100, 80, 65, 50, 35, 10].map(readabilityBand)).toEqual(['very_easy', 'easy', 'plain', 'fairly_hard', 'hard', 'very_hard']);
    });
});

describe('scheduling a check', () => {
    it('adds the scene’s check debounced by the queue: deduplicated per scene, rescheduled by a newer save, kept while one runs', async () => {
        const calls: unknown[] = [];
        const r = await scheduleProseCheck('ws1', 'scene1', { enqueue: async (payload, opts) => void calls.push({ payload, opts }) });
        expect(r).toBe('SCHEDULED');
        expect(calls).toEqual([{ payload: { workspaceId: 'ws1', sceneId: 'scene1' }, opts: { delay: PROSE_CHECK_DEBOUNCE_MS, deduplication: { id: 'prose-check-scene1', reschedule: true, keepLastIfActive: true } } }]);
        expect(proseCheckDedupId('abc')).not.toContain(':');
    });
    it('never fails the caller: an unreachable queue is UNAVAILABLE, and PROSE_CHECKS=off queues nothing', async () => {
        await expect(scheduleProseCheck('ws1', 's', { enqueue: async () => Promise.reject(new Error('redis down')) })).resolves.toBe('UNAVAILABLE');
        process.env.PROSE_CHECKS = 'off';
        await expect(scheduleProseCheck('ws1', 's')).resolves.toBe('OFF');
    });
});

describe('the workspace’s minute', () => {
    it('lets a check run until the bound, then answers how long to wait', () => {
        const config = { maxAttempts: 2, windowMs: 60_000 };
        const ws = `ws-${Math.random()}`;
        expect(chargeProseCheckRun(ws, config, () => false)).toBe(0);
        expect(chargeProseCheckRun(ws, config, () => false)).toBe(0);
        expect(chargeProseCheckRun(ws, config, () => false)).toBeGreaterThanOrEqual(1_000);
        expect(chargeProseCheckRun(ws, config, () => true)).toBe(0);
    });
});
