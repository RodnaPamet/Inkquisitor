/**
 * THE MODEL LAYER'S DEPLOYMENT SWITCHES (Phase 2.1), as pure functions of an
 * env record, so the start-up check (`src/lib/startup-checks.ts`) and the
 * layer read them one way.
 *
 *   AI_DISABLED=1                    the global kill switch: every call is
 *                                    refused before anything is read or sent,
 *                                    and recorded KILLED
 *   AI_MONTHLY_CEILING_USD_DEFAULT   each workspace's spend ceiling per UTC
 *                                    calendar month, in US dollars (default
 *                                    25, a placeholder the owner may change)
 *   ANTHROPIC_API_KEY                the provider key. Optional: without it
 *                                    the product runs with AI unavailable
 *   ANTHROPIC_ZDR_CONFIRMED=1        the operator's statement that the
 *                                    Anthropic organization this key belongs
 *                                    to has a zero-data-retention arrangement
 *                                    (decision D5; below)
 *
 * ── ZERO DATA RETENTION IS AN ARRANGEMENT, NOT A REQUEST PARAMETER ─────────
 *
 * Anthropic enables ZDR per ORGANIZATION, by its account team; there is no
 * header or body member a request can carry to ask for it (Anthropic's "API
 * and data retention" documentation, read 2026-11-19). So nothing in code can
 * make a call zero-retention. What code can do is (a) refuse to send anything
 * a ZDR arrangement does not cover, which the messages-only middleware in
 * `./client.ts` does (no batches, files, threads, containers, MCP or server
 * tools, no beta header), and (b) refuse to start in production holding a key
 * nobody has said is covered. That is this file's `aiConfigProblems`: in
 * production a set `ANTHROPIC_API_KEY` requires `ANTHROPIC_ZDR_CONFIRMED=1`,
 * and `clientForRun` refuses again (`ZDR_NOT_CONFIRMED`) as the second line.
 * The confirmation is an operator's act, checked against the contract before
 * the variable is set; it is not evidence of the arrangement.
 *
 * ANTHROPIC_API_KEY is NOT required in production in 2.1: nothing calls a model
 * in production before the question engine (2.2). It becomes required when the
 * first product surface that calls a model ships (2.2 adds it to
 * `aiConfigProblems`).
 */

/** The variables this file reads, from `process.env`, `env` or a test's object. */
export type AiEnvRecord = {
    readonly [K in
        | 'AI_DISABLED'
        | 'AI_MONTHLY_CEILING_USD_DEFAULT'
        | 'ANTHROPIC_API_KEY'
        | 'ANTHROPIC_ZDR_CONFIRMED'
        | 'ANTHROPIC_CUSTOM_HEADERS']?: string | undefined;
};

/** The default monthly ceiling per workspace when `AI_MONTHLY_CEILING_USD_DEFAULT` is unset: $25. */
export const DEFAULT_MONTHLY_CEILING_USD = 25;

/** The largest ceiling the variable may name, so a typo of zeros is refused rather than obeyed. */
export const MAX_MONTHLY_CEILING_USD = 100_000;

const present = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/** The kill switch. Only the exact value `1` turns AI off; `0` and unset leave it on. */
export function aiDisabled(e: AiEnvRecord): boolean {
    return e.AI_DISABLED?.trim() === '1';
}

/** Parse a dollar figure into micro-dollars, or null when it is not a figure in range. */
export function parseCeilingUsd(raw: string): number | null {
    const text = raw.trim();
    if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
    const usd = Number(text);
    if (!Number.isFinite(usd) || usd < 0 || usd > MAX_MONTHLY_CEILING_USD) return null;
    return Math.round(usd * 1_000_000);
}

/**
 * Every workspace's monthly ceiling in micro-dollars. A malformed value never
 * widens the ceiling: it reads as the default (and the start-up check refuses
 * it in production).
 */
export function monthlyCeilingMicroUsd(e: AiEnvRecord): number {
    const raw = e.AI_MONTHLY_CEILING_USD_DEFAULT;
    const parsed = present(raw) ? parseCeilingUsd(raw) : null;
    return parsed ?? DEFAULT_MONTHLY_CEILING_USD * 1_000_000;
}

/** Whether the operator has stated the key's organization has zero data retention. */
export function zdrConfirmed(e: AiEnvRecord): boolean {
    return e.ANTHROPIC_ZDR_CONFIRMED?.trim() === '1';
}

/** What a production process refuses to start with, for the model layer. Empty when fit. */
export function aiConfigProblems(e: AiEnvRecord): string[] {
    const problems: string[] = [];
    if (present(e.ANTHROPIC_API_KEY) && !zdrConfirmed(e)) {
        problems.push(
            'ANTHROPIC_API_KEY is set without ANTHROPIC_ZDR_CONFIRMED=1: author text reaches the model provider only ' +
                "under zero-retention terms (decision D5), which Anthropic enables per organization. Confirm the key's " +
                'organization has a ZDR arrangement, then set ANTHROPIC_ZDR_CONFIRMED=1; or unset the key.',
        );
    }
    if (present(e.ANTHROPIC_CUSTOM_HEADERS)) {
        problems.push(
            'ANTHROPIC_CUSTOM_HEADERS must be unset: the SDK adds it to every request, and the model layer refuses to ' +
                'build a client while it is set.',
        );
    }
    if (present(e.AI_MONTHLY_CEILING_USD_DEFAULT) && parseCeilingUsd(e.AI_MONTHLY_CEILING_USD_DEFAULT) === null) {
        problems.push(
            `AI_MONTHLY_CEILING_USD_DEFAULT must be a dollar figure from 0 to ${MAX_MONTHLY_CEILING_USD} (e.g. 25 or 12.50).`,
        );
    }
    if (present(e.AI_DISABLED) && !['0', '1'].includes(e.AI_DISABLED.trim())) {
        problems.push('AI_DISABLED must be 0 or 1.');
    }
    return problems;
}
