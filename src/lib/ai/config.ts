/**
 * THE MODEL LAYER'S DEPLOYMENT SWITCHES (Phase 2.1; amended in 2.2), as pure
 * functions of an env record, so the start-up check
 * (`src/lib/startup-checks.ts`), the client seam and the features read them
 * one way.
 *
 *   AI_DISABLED=1                    the global kill switch: every call is
 *                                    refused before anything is read or sent,
 *                                    and recorded KILLED
 *   AI_MONTHLY_CEILING_USD_DEFAULT   each workspace's spend ceiling per UTC
 *                                    calendar month, in US dollars (default
 *                                    50, decision D10)
 *   ANTHROPIC_API_KEY                the provider key. REQUIRED in production
 *                                    since 2.2 (the question engine calls a
 *                                    model), unless AI_DISABLED=1; optional in
 *                                    development, where AI is then unavailable
 *   AI_RETENTION_MODE                how the key's organization retains what it
 *                                    is sent: `zdr` or `standard-beta`
 *                                    (decision D5, amended 2026-11-19; below)
 *   ANTHROPIC_ZDR_CONFIRMED=1        the 2.1 spelling of `AI_RETENTION_MODE=zdr`
 *   ANTHROPIC_WORKSPACE_ID           optional (2.3): the workspace an
 *                                    organisation-level key's requests name;
 *                                    a malformed one is refused at start
 *   AI_MODEL_STUB=1                  the in-process stubbed model (Phase 2.4,
 *                                    `./model-stub.ts`): canned questions, for
 *                                    a local test server only; production
 *                                    refuses it unless APP_URL and NEXTAUTH_URL
 *                                    are both loopback, and beside a key
 *
 * ── RETENTION IS AN ARRANGEMENT, NOT A REQUEST PARAMETER ───────────────────
 *
 * Anthropic enables zero data retention per ORGANIZATION, by its account team;
 * there is no header or body member a request can carry to ask for it
 * (Anthropic's "API and data retention" documentation, read 2026-11-19). So
 * nothing in code can make a call zero-retention. What code can do is (a)
 * refuse to send anything a ZDR arrangement does not cover, which the
 * messages-only middleware in `./client.ts` does (no batches, files, threads,
 * containers, MCP or server tools, no beta header), and (b) refuse to run in
 * production holding a key whose retention nobody has declared.
 *
 * D5 as amended (2026-11-19): standard retention is permitted during a closed
 * beta, as an explicit operator choice, and zero retention is required before
 * public launch (the Phase 7 launch gate). So production must DECLARE a mode:
 *
 *   zdr            the operator states the key's organization has a ZDR
 *                  arrangement (checked against the contract before setting)
 *   standard-beta  the operator chooses standard retention for the closed
 *                  beta; every start of the web tier and the worker logs a
 *                  WARN naming it (`aiConfigWarnings`)
 *
 * A key with no declared mode refuses to start (`aiConfigProblems`), and
 * `clientForRun` refuses again in production (`RETENTION_MODE_UNDECLARED`).
 * There is no default: standard retention is never what an unset variable
 * means. Whatever the mode, no output schema is ever built from author text
 * (the API caches a compiled schema outside zero retention).
 */

import { isAnthropicWorkspaceId } from './anthropic-workspace';
import { loopbackStubMode, stubModelEnabled, stubModelProblems } from './model-stub';

/**
 * The stubbed model is answering (Phase 2.4): switched on, and no provider key
 * configured beside it (a key wins; production refuses the pair at start-up,
 * `stubModelProblems`). In production, only in D13's loopback-only mode, asked
 * here too and not only at start-up: a process whose start-up check did not
 * run (it is skipped for `next build`) still never answers a real host's
 * authors with canned questions.
 */
export function stubModelActive(e: AiEnvRecord): boolean {
    if (e.NODE_ENV === 'production') return loopbackStubMode(e);
    return stubModelEnabled(e) && !present(e.ANTHROPIC_API_KEY);
}

/** The variables this file reads, from `process.env`, `env` or a test's object. */
export type AiEnvRecord = {
    readonly [K in
        | 'AI_DISABLED'
        | 'AI_MONTHLY_CEILING_USD_DEFAULT'
        | 'ANTHROPIC_API_KEY'
        | 'AI_RETENTION_MODE'
        | 'ANTHROPIC_ZDR_CONFIRMED'
        | 'ANTHROPIC_CUSTOM_HEADERS'
        | 'ANTHROPIC_WORKSPACE_ID'
        | 'AI_MODEL_STUB'
        | 'APP_URL'
        | 'NEXTAUTH_URL'
        | 'NODE_ENV']?: string | undefined;
};

/** The default monthly ceiling per workspace when `AI_MONTHLY_CEILING_USD_DEFAULT` is unset: $50 (decision D10). */
export const DEFAULT_MONTHLY_CEILING_USD = 50;

/** The retention modes an operator may declare (decision D5, amended 2026-11-19). */
export const RETENTION_MODES = ['zdr', 'standard-beta'] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];

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

/**
 * The declared retention mode: `AI_RETENTION_MODE` when it names one, else
 * `zdr` when the 2.1 statement `ANTHROPIC_ZDR_CONFIRMED=1` is set, else
 * `null` (undeclared). A malformed `AI_RETENTION_MODE` declares nothing (and
 * production refuses it).
 */
export function retentionMode(e: AiEnvRecord): RetentionMode | null {
    const raw = e.AI_RETENTION_MODE?.trim();
    if (present(raw)) return (RETENTION_MODES as readonly string[]).includes(raw) ? (raw as RetentionMode) : null;
    return e.ANTHROPIC_ZDR_CONFIRMED?.trim() === '1' ? 'zdr' : null;
}

/** Whether the declared mode is zero retention (the 2.1 name, kept for its callers). */
export function zdrConfirmed(e: AiEnvRecord): boolean {
    return retentionMode(e) === 'zdr';
}

/** Why no model call can be made at all under this configuration, or null. Pure; `clientForRun` asks it. */
export type AiConfigUnavailableReason = 'AI_DISABLED' | 'CREDENTIAL_NOT_CONFIGURED' | 'SDK_AMBIENT_HEADERS_SET' | 'RETENTION_MODE_UNDECLARED';

export function aiUnavailableReason(e: AiEnvRecord): AiConfigUnavailableReason | null {
    if (aiDisabled(e)) return 'AI_DISABLED';
    // The stubbed model (Phase 2.4, `./model-stub.ts`) answers in-process: no
    // key and no retention apply, as nothing is sent. A configured key wins.
    if (stubModelActive(e)) return present(e.ANTHROPIC_CUSTOM_HEADERS) ? 'SDK_AMBIENT_HEADERS_SET' : null;
    if (!present(e.ANTHROPIC_API_KEY)) return 'CREDENTIAL_NOT_CONFIGURED';
    if (present(e.ANTHROPIC_CUSTOM_HEADERS)) return 'SDK_AMBIENT_HEADERS_SET';
    if (e.NODE_ENV === 'production' && retentionMode(e) === null) return 'RETENTION_MODE_UNDECLARED';
    return null;
}

/** What a production process refuses to start with, for the model layer. Empty when fit. */
export function aiConfigProblems(e: AiEnvRecord): string[] {
    const problems: string[] = [...stubModelProblems(e)];
    if (!present(e.ANTHROPIC_API_KEY) && !aiDisabled(e) && !stubModelEnabled(e)) {
        problems.push(
            'ANTHROPIC_API_KEY is required: the question engine calls a model. Set the key (and AI_RETENTION_MODE), ' +
                'or run with AI switched off (AI_DISABLED=1).',
        );
    }
    const rawMode = e.AI_RETENTION_MODE;
    if (present(rawMode) && !(RETENTION_MODES as readonly string[]).includes(rawMode.trim())) {
        problems.push(`AI_RETENTION_MODE must be one of: ${RETENTION_MODES.join(', ')}.`);
    } else if (present(e.ANTHROPIC_API_KEY) && retentionMode(e) === null) {
        problems.push(
            'ANTHROPIC_API_KEY is set without a declared retention mode (decision D5): set AI_RETENTION_MODE=zdr once ' +
                "the key's organization has a zero-data-retention arrangement with Anthropic, or AI_RETENTION_MODE=" +
                'standard-beta to accept standard retention during the closed beta; or unset the key.',
        );
    }
    if (rawMode?.trim() === 'standard-beta' && e.ANTHROPIC_ZDR_CONFIRMED?.trim() === '1') {
        problems.push(
            'AI_RETENTION_MODE=standard-beta contradicts ANTHROPIC_ZDR_CONFIRMED=1: declare one retention mode (unset ' +
                'ANTHROPIC_ZDR_CONFIRMED, or set AI_RETENTION_MODE=zdr).',
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
            `AI_MONTHLY_CEILING_USD_DEFAULT must be a dollar figure from 0 to ${MAX_MONTHLY_CEILING_USD} (e.g. 50 or 12.50).`,
        );
    }
    if (present(e.ANTHROPIC_WORKSPACE_ID) && !isAnthropicWorkspaceId(e.ANTHROPIC_WORKSPACE_ID)) {
        problems.push(
            'ANTHROPIC_WORKSPACE_ID must be an Anthropic workspace id (letters, digits, _ and -, as in wrkspc_…): it is sent as the ' +
                'anthropic-workspace-id header, and a malformed one never is. Unset it for a workspace-scoped key.',
        );
    }
    if (present(e.AI_DISABLED) && !['0', '1'].includes(e.AI_DISABLED.trim())) {
        problems.push('AI_DISABLED must be 0 or 1.');
    }
    return problems;
}

/**
 * What a production process starts with but must say out loud: today, the
 * closed beta's standard retention (decision D5, amended 2026-11-19). Each is
 * a fixed sentence naming the setting, never anything an author wrote.
 */
export function aiConfigWarnings(e: AiEnvRecord): string[] {
    if (stubModelActive(e)) {
        return ['AI_MODEL_STUB=1: every model call is answered by the in-process stub with canned questions. A local test server only.'];
    }
    if (!present(e.ANTHROPIC_API_KEY) || aiDisabled(e)) return [];
    if (retentionMode(e) !== 'standard-beta') return [];
    return [
        'AI_RETENTION_MODE=standard-beta: author text sent to the model provider is kept under Anthropic\'s standard ' +
            'retention, not zero retention. Permitted during the closed beta only (decision D5); zero retention ' +
            '(AI_RETENTION_MODE=zdr) is required before public launch.',
    ];
}
