/**
 * The model tiers, the deployment switches and the price table (Phase 2.1).
 *
 * A tier names a model the deployment chose, overridable by env; a malformed
 * override is never sent. The price table is the one source of every cost the
 * spend ceiling counts: its arithmetic is integer, rounded up, long prompts are
 * dearer on Haiku 5.5, and an unknown model is priced at the dearest rates.
 */
import {
    aiConfigProblems,
    aiConfigWarnings,
    aiDisabled,
    aiUnavailableReason,
    DEFAULT_MONTHLY_CEILING_USD,
    monthlyCeilingMicroUsd,
    parseCeilingUsd,
    retentionMode,
    zdrConfirmed,
} from '@/lib/ai/config';
import { CONSERVATIVE_CAPABILITIES, MODEL_CAPABILITIES, MODEL_FAMILIES, modelCapabilitiesFor, modelFamilyOf } from '@/lib/ai/model-capabilities';
import { costMicroUsd, MODEL_PRICES, priceFor, tokensCost, UNKNOWN_MODEL_PRICE, worstCaseCostMicroUsd } from '@/lib/ai/pricing';
import { MODEL_TIERS, modelForTier, TIER_DEFAULTS, TIER_MODEL_ENV } from '@/lib/ai/tiers';

describe('tiers', () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
        for (const v of Object.values(TIER_MODEL_ENV)) saved[v] = process.env[v];
    });
    afterEach(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    it('defaults to the Claude 5 family: Haiku 5.5, Sonnet 5.5, Opus 5.5', () => {
        for (const v of Object.values(TIER_MODEL_ENV)) delete process.env[v];
        expect(modelForTier('fast')).toBe('claude-haiku-5-5');
        expect(modelForTier('balanced')).toBe('claude-sonnet-5-5');
        expect(modelForTier('deep')).toBe('claude-opus-5-5');
    });

    it('each tier is overridable by its own variable, and only by it', () => {
        process.env.AI_MODEL_DEEP = 'claude-fable-5-2';
        expect(modelForTier('deep')).toBe('claude-fable-5-2');
        expect(modelForTier('balanced')).toBe('claude-sonnet-5-5');
    });

    it('a malformed override is never sent: the default stands', () => {
        process.env.AI_MODEL_FAST = 'Claude Haiku; drop table';
        expect(modelForTier('fast')).toBe('claude-haiku-5-5');
    });

    it('every tier has a priced, structured-output default with a bounded budget and deadline', () => {
        for (const tier of MODEL_TIERS) {
            const d = TIER_DEFAULTS[tier];
            expect(modelFamilyOf(d.model)).toBe(d.model);
            expect(modelCapabilitiesFor(d.model).structuredOutput).toBe(true);
            expect(d.maxOutputTokens).toBeGreaterThan(0);
            expect(d.maxOutputTokens).toBeLessThanOrEqual(128_000);
            expect(d.timeoutMs).toBeGreaterThan(0);
        }
    });
});

describe('model capabilities', () => {
    it('matches a family alone or with a dated snapshot, and nothing looser', () => {
        expect(modelFamilyOf('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
        expect(modelFamilyOf('claude-opus-5-5')).toBe('claude-opus-5-5');
        // `claude-opus-5` is not a prefix of `claude-opus-5-5`.
        expect(modelFamilyOf('claude-opus-5-5')).not.toBe('claude-opus-5');
        expect(modelFamilyOf('claude-opus-5-5x')).toBeNull();
        expect(modelFamilyOf('claude-opus-6')).toBeNull();
    });

    it('an unknown model fails closed to what every model accepts', () => {
        expect(modelCapabilitiesFor('claude-opus-6')).toEqual(CONSERVATIVE_CAPABILITIES);
        expect(CONSERVATIVE_CAPABILITIES).toEqual({ effort: false, structuredOutput: false });
    });

    it('every family has a capability row and a price', () => {
        for (const f of MODEL_FAMILIES) {
            expect(MODEL_CAPABILITIES[f]).toBeDefined();
            expect(MODEL_PRICES[f]).toBeDefined();
        }
    });
});

describe('pricing', () => {
    it('reads the list prices of the three default models (µUSD per million tokens)', () => {
        expect(MODEL_PRICES['claude-opus-5-5']).toEqual({ input: 4_000_000, cacheWrite: 5_000_000, cacheRead: 200_000, output: 20_000_000 });
        expect(MODEL_PRICES['claude-sonnet-5-5']).toEqual({ input: 2_000_000, cacheWrite: 2_500_000, cacheRead: 100_000, output: 10_000_000 });
        expect(MODEL_PRICES['claude-haiku-5-5']).toMatchObject({ input: 100_000, cacheWrite: 125_000, cacheRead: 10_000, output: 500_000 });
    });

    it('integer arithmetic, rounded up, never below the bill', () => {
        expect(tokensCost(0, 4_000_000)).toBe(0);
        expect(tokensCost(1, 4_000_000)).toBe(4);
        expect(tokensCost(1, 100_000)).toBe(1); // 0.1 µUSD rounds up to 1
        expect(tokensCost(1_000_000, 4_000_000)).toBe(4_000_000);
        // Opus 5.5: 1 000 in, 200 out = $0.004 + $0.004.
        expect(costMicroUsd('claude-opus-5-5', { inputTokens: 1_000, outputTokens: 200 })).toBe(4_000 + 4_000);
    });

    it('prices cache writes and reads at their own rates', () => {
        const c = costMicroUsd('claude-sonnet-5-5', {
            inputTokens: 100,
            outputTokens: 0,
            cacheWriteTokens: 1_000_000,
            cacheReadTokens: 1_000_000,
        });
        expect(c).toBe(200 + 2_500_000 + 100_000);
    });

    it('Haiku 5.5: a prompt over 100 000 tokens pays the long-prompt row for every token', () => {
        const short = costMicroUsd('claude-haiku-5-5', { inputTokens: 100_000, outputTokens: 1_000 });
        const long = costMicroUsd('claude-haiku-5-5', { inputTokens: 100_001, outputTokens: 1_000 });
        expect(short).toBe(10_000 + 500);
        expect(long).toBe(Math.ceil(100_001 * 0.5) + 2_500);
        // Cache reads count toward the prompt length.
        expect(costMicroUsd('claude-haiku-5-5', { inputTokens: 50_000, cacheReadTokens: 60_000, outputTokens: 0 })).toBe(
            25_000 + 3_000,
        );
    });

    it('an unknown model is priced at the dearest rate of every column', () => {
        expect(priceFor('claude-opus-9')).toBe(UNKNOWN_MODEL_PRICE);
        for (const f of MODEL_FAMILIES) {
            expect(UNKNOWN_MODEL_PRICE.output).toBeGreaterThanOrEqual(MODEL_PRICES[f].output);
            expect(UNKNOWN_MODEL_PRICE.input).toBeGreaterThanOrEqual(MODEL_PRICES[f].input);
        }
        expect(UNKNOWN_MODEL_PRICE.output).toBe(50_000_000);
    });

    it('the worst case prices every input token at the dearer of input and cache write, and is never below a real cost', () => {
        const worst = worstCaseCostMicroUsd('claude-opus-5-5', { inputTokens: 10_000, outputTokens: 2_000 });
        expect(worst).toBe(10_000 * 5 + 2_000 * 20);
        for (const usage of [
            { inputTokens: 10_000, outputTokens: 2_000 },
            { inputTokens: 0, cacheWriteTokens: 10_000, outputTokens: 2_000 },
            { inputTokens: 5_000, cacheReadTokens: 5_000, outputTokens: 2_000 },
        ]) {
            expect(costMicroUsd('claude-opus-5-5', usage)).toBeLessThanOrEqual(worst);
        }
        // Haiku: a bound past the threshold takes the long-prompt row.
        expect(worstCaseCostMicroUsd('claude-haiku-5-5', { inputTokens: 200_000, outputTokens: 0 })).toBe(200_000 * 0.625);
    });
});

describe('deployment switches', () => {
    it('the kill switch is on only for exactly 1', () => {
        expect(aiDisabled({ AI_DISABLED: '1' })).toBe(true);
        expect(aiDisabled({ AI_DISABLED: ' 1 ' })).toBe(true);
        expect(aiDisabled({ AI_DISABLED: '0' })).toBe(false);
        expect(aiDisabled({})).toBe(false);
    });

    it('the ceiling defaults to $50 (decision D10), and a bad value never widens it', () => {
        expect(DEFAULT_MONTHLY_CEILING_USD).toBe(50);
        expect(monthlyCeilingMicroUsd({})).toBe(50_000_000);
        expect(monthlyCeilingMicroUsd({ AI_MONTHLY_CEILING_USD_DEFAULT: '12.5' })).toBe(12_500_000);
        expect(monthlyCeilingMicroUsd({ AI_MONTHLY_CEILING_USD_DEFAULT: '0' })).toBe(0);
        expect(monthlyCeilingMicroUsd({ AI_MONTHLY_CEILING_USD_DEFAULT: '9e9' })).toBe(50_000_000);
        expect(monthlyCeilingMicroUsd({ AI_MONTHLY_CEILING_USD_DEFAULT: '-5' })).toBe(50_000_000);
        expect(parseCeilingUsd('100001')).toBeNull();
    });

    it('zero retention is stated by AI_RETENTION_MODE=zdr, or by the 2.1 spelling ANTHROPIC_ZDR_CONFIRMED=1', () => {
        expect(retentionMode({ AI_RETENTION_MODE: 'zdr' })).toBe('zdr');
        expect(retentionMode({ AI_RETENTION_MODE: 'standard-beta' })).toBe('standard-beta');
        expect(retentionMode({ ANTHROPIC_ZDR_CONFIRMED: '1' })).toBe('zdr');
        expect(retentionMode({ ANTHROPIC_ZDR_CONFIRMED: '0' })).toBeNull();
        expect(retentionMode({})).toBeNull();
        // A malformed mode declares nothing; it never reads as standard retention.
        expect(retentionMode({ AI_RETENTION_MODE: 'standard' })).toBeNull();
        expect(zdrConfirmed({ ANTHROPIC_ZDR_CONFIRMED: '1' })).toBe(true);
        expect(zdrConfirmed({ AI_RETENTION_MODE: 'standard-beta' })).toBe(false);
    });

    it('aiConfigProblems (production): the key is required unless AI is off, and a key needs a declared retention mode', () => {
        expect(aiConfigProblems({}).join(' ')).toMatch(/ANTHROPIC_API_KEY is required/);
        expect(aiConfigProblems({ AI_DISABLED: '1' })).toEqual([]);
        expect(aiConfigProblems({ ANTHROPIC_API_KEY: 'k' }).join(' ')).toMatch(/AI_RETENTION_MODE/);
        expect(aiConfigProblems({ ANTHROPIC_API_KEY: 'k', AI_RETENTION_MODE: 'zdr' })).toEqual([]);
        expect(aiConfigProblems({ ANTHROPIC_API_KEY: 'k', AI_RETENTION_MODE: 'standard-beta' })).toEqual([]);
        expect(aiConfigProblems({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_ZDR_CONFIRMED: '1' })).toEqual([]);
        expect(aiConfigProblems({ ANTHROPIC_API_KEY: 'k', AI_RETENTION_MODE: 'standard' }).join(' ')).toMatch(/must be one of: zdr, standard-beta/);
        expect(aiConfigProblems({ ANTHROPIC_API_KEY: 'k', AI_RETENTION_MODE: 'standard-beta', ANTHROPIC_ZDR_CONFIRMED: '1' }).join(' ')).toMatch(/contradicts/);
    });

    it('standard-beta is said out loud: one WARN, naming the setting, never anything else', () => {
        expect(aiConfigWarnings({ ANTHROPIC_API_KEY: 'k', AI_RETENTION_MODE: 'standard-beta' })).toEqual([expect.stringMatching(/^AI_RETENTION_MODE=standard-beta: .*closed beta/)]);
        expect(aiConfigWarnings({ ANTHROPIC_API_KEY: 'k', AI_RETENTION_MODE: 'zdr' })).toEqual([]);
        expect(aiConfigWarnings({ AI_RETENTION_MODE: 'standard-beta' })).toEqual([]);
        expect(aiConfigWarnings({ ANTHROPIC_API_KEY: 'k', AI_RETENTION_MODE: 'standard-beta', AI_DISABLED: '1' })).toEqual([]);
    });

    it('aiUnavailableReason: the kill switch, then the key, then ambient headers, then (production) the retention mode', () => {
        expect(aiUnavailableReason({ AI_DISABLED: '1', ANTHROPIC_API_KEY: 'k' })).toBe('AI_DISABLED');
        expect(aiUnavailableReason({})).toBe('CREDENTIAL_NOT_CONFIGURED');
        expect(aiUnavailableReason({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_CUSTOM_HEADERS: 'x: y' })).toBe('SDK_AMBIENT_HEADERS_SET');
        expect(aiUnavailableReason({ ANTHROPIC_API_KEY: 'k', NODE_ENV: 'production' })).toBe('RETENTION_MODE_UNDECLARED');
        expect(aiUnavailableReason({ ANTHROPIC_API_KEY: 'k', NODE_ENV: 'production', AI_RETENTION_MODE: 'standard-beta' })).toBeNull();
        expect(aiUnavailableReason({ ANTHROPIC_API_KEY: 'k' })).toBeNull();
    });
});
