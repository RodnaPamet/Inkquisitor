/**
 * AI Guard — the thin wrapper Inkquisitor's model layer calls.
 *
 * Written new for Inkquisitor (the scanners under this folder are lifted from
 * inflect-compliance; see docs/carve-manifest.md). Inflect's wrapper resolves
 * a per-tenant mode from the database and writes a hash-chained audit row for
 * every non-clean verdict. This one does neither: it scans, resolves the
 * enforcement action for the mode it is GIVEN, and returns a `GuardCheck`.
 * The model layer records every check in the call record (`../call-log.ts`),
 * which is where the evidence lives.
 *
 *   guardInput(text, …)    author text on its way INTO a prompt
 *   guardOutput(value, …)  model output on its way OUT to the caller
 *
 * A check carries rule ids, never the text it scanned, so it is safe to log
 * and to store. The verdict vocabulary maps onto the brief's levels:
 *
 *   action 'block'                → BLOCK  the call is refused
 *   action 'flag'                 → WARN   the call proceeds; the check is recorded
 *   action 'allow', non-clean     → INFO   audit mode; recorded, not enforced
 *   action 'allow', clean         →        recorded as clean (scanned, nothing fired)
 *
 * Neither function throws: the caller applies the block (`callStructured`
 * raises `AiGuardBlockedError`).
 */
import type { GuardVerdict } from './injection-scanner';
import { DEFAULT_GUARD_MODE, resolveEnforcement, type GuardAction, type GuardDirection, type GuardMode } from './policy';
import { scanWithProviders } from './providers/compose';
import { patternsProvider } from './providers/patterns-provider';
import type { GuardProvider } from './providers/types';

export { normalizeForScan } from './normalize';
export { scanInjection } from './injection-scanner';
export type { GuardVerdict, ScanResult } from './injection-scanner';
export { scanEgress } from './egress-scanner';
export { resolveGuardMode, resolveEnforcement, DEFAULT_GUARD_MODE } from './policy';
export type { GuardMode, GuardAction, GuardDirection } from './policy';
export { INJECTION_RULES, EGRESS_RULES } from './patterns';

/** The providers every check consults. One today: the deterministic patterns. */
export const DEFAULT_GUARD_PROVIDERS: readonly GuardProvider[] = [patternsProvider];

/** The outcome of one scan. No text: rule ids only. */
export interface GuardCheck {
    readonly direction: GuardDirection;
    /** What was scanned, named by code (a data-block label, or `output`). Never author text. */
    readonly source: string;
    readonly verdict: GuardVerdict;
    readonly action: GuardAction;
    readonly mode: GuardMode;
    /** Stable rule ids that fired. */
    readonly ruleIds: readonly string[];
}

export interface GuardCallOptions {
    readonly source: string;
    readonly callId: string;
    readonly mode?: GuardMode;
    /** The providers to consult in place of `DEFAULT_GUARD_PROVIDERS`. A test seam. */
    readonly providers?: readonly GuardProvider[];
}

async function check(direction: GuardDirection, content: unknown, opts: GuardCallOptions): Promise<GuardCheck> {
    const mode = opts.mode ?? DEFAULT_GUARD_MODE;
    const composed = await scanWithProviders(opts.providers ?? DEFAULT_GUARD_PROVIDERS, direction, content, {
        callId: opts.callId,
    });
    return {
        direction,
        source: opts.source,
        verdict: composed.scan.verdict,
        action: resolveEnforcement(mode, composed.scan.verdict, direction),
        mode,
        ruleIds: [...composed.scan.ruleIds],
    };
}

/** Scan author text before it is placed in a prompt. */
export function guardInput(text: string, opts: GuardCallOptions): Promise<GuardCheck> {
    return check('input', text, opts);
}

/** Scan model output (any JSON-ish value) before it is handed back. */
export function guardOutput(value: unknown, opts: GuardCallOptions): Promise<GuardCheck> {
    return check('egress', value, opts);
}

/** True when a check's action refuses the call. */
export function isBlocked(c: GuardCheck): boolean {
    return c.action === 'block';
}
