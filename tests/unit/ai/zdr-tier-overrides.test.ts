/**
 * Under AI_RETENTION_MODE=zdr a tier override must name a model the
 * arrangement covers (issue #30 item 6). The Fable family is a Covered Model
 * (30-day retention required), so a ZDR organization's request to it is a 400
 * on every call; a model the capability table has no row for cannot be
 * vouched for. Production refuses to start with either, naming the variable.
 */
import { aiConfigProblems } from '@/lib/ai/config';
import { MODEL_FAMILIES, ZDR_ELIGIBLE, zdrEligible } from '@/lib/ai/model-capabilities';
import { TIER_DEFAULTS } from '@/lib/ai/tiers';

const ZDR = { ANTHROPIC_API_KEY: 'k', AI_RETENTION_MODE: 'zdr' } as const;
const problemsFor = (e: Record<string, string>) => aiConfigProblems(e).filter((p) => /zero-data-retention organization cannot call/.test(p));

it('refuses a Fable override, and an unknown model, under zdr; naming the variable', () => {
    expect(problemsFor({ ...ZDR, AI_MODEL_DEEP: 'claude-fable-5-2' })).toEqual([expect.stringMatching(/^AI_MODEL_DEEP /)]);
    expect(problemsFor({ ...ZDR, AI_MODEL_BALANCED: 'claude-fable-5-1-20261001' })).toEqual([expect.stringMatching(/^AI_MODEL_BALANCED /)]);
    expect(problemsFor({ ...ZDR, AI_MODEL_FAST: 'claude-mythos-5-2' })).toEqual([expect.stringMatching(/^AI_MODEL_FAST /)]);
    expect(problemsFor({ ...ZDR, ANTHROPIC_ZDR_CONFIRMED: '1', AI_RETENTION_MODE: '', AI_MODEL_DEEP: 'claude-fable-5' })).toHaveLength(1);
});

it('accepts an eligible override under zdr, and any override under standard-beta', () => {
    expect(problemsFor({ ...ZDR, AI_MODEL_DEEP: 'claude-opus-5', AI_MODEL_FAST: 'claude-haiku-4-5-20251001' })).toEqual([]);
    expect(problemsFor({ ANTHROPIC_API_KEY: 'k', AI_RETENTION_MODE: 'standard-beta', AI_MODEL_DEEP: 'claude-fable-5-2' })).toEqual([]);
});

it('every tier default is eligible, and only the Fable family is not', () => {
    for (const d of Object.values(TIER_DEFAULTS)) expect([d.model, zdrEligible(d.model)]).toEqual([d.model, true]);
    expect(MODEL_FAMILIES.filter((f) => !ZDR_ELIGIBLE[f])).toEqual(['claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5']);
});
