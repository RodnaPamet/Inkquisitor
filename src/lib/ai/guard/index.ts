/**
 * AI Guard — the thin wrapper the model layer calls (Phase 2.1).
 *
 * Written new for Inkquisitor; the scanners beside it are lifted from
 * inflect-compliance (see docs/carve-manifest.md). Inflect's wrapper reads a
 * per-tenant mode from the database, consults remote guard providers and
 * writes a hash-chained audit row for every non-clean verdict. This one does
 * none of that. It is pure and synchronous: it scans, resolves the enforcement
 * action for the mode it is GIVEN (the prompt template's), and returns
 * `GuardCheck`s. The model layer records the outcome on the call's
 * `AiCallLog` row (the rule ids, never the text), which is where the evidence
 * lives; no audit coupling.
 *
 *   guardAuthorText(blocks, mode)   author text on its way INTO a prompt
 *                                   (the injection scanner, per data block)
 *   guardModelOutput(value, mode)   the model's answer on its way OUT to the
 *                                   caller (the egress / DLP scanner)
 *
 * What the policy (`./policy.ts`) decides, and what the caller does with it:
 *
 *   action 'block'   the call is refused: nothing is sent (input), or the
 *                    answer is withheld (output). Outcome REFUSED_GUARD.
 *   action 'flag'    "flag and fence": the call proceeds — author text is
 *                    fenced as data whatever its verdict — and the result
 *                    says `reviewRequired`, so nothing downstream may apply
 *                    it without a person (roadmap rule 1 holds anyway).
 *   action 'allow'   clean, or audit mode.
 *
 * A check carries rule ids and a code-supplied source name, never the text it
 * scanned, so it is safe to log and to store.
 */
import { scanEgress } from './egress-scanner';
import { scanInjection, type GuardVerdict } from './injection-scanner';
import { DEFAULT_GUARD_MODE, resolveEnforcement, type GuardAction, type GuardDirection, type GuardMode } from './policy';

export { normalizeForScan } from './normalize';
export { scanInjection } from './injection-scanner';
export type { GuardVerdict, ScanResult } from './injection-scanner';
export { scanEgress } from './egress-scanner';
export { DEFAULT_GUARD_MODE, resolveEnforcement, resolveGuardMode } from './policy';
export type { GuardAction, GuardDirection, GuardMode } from './policy';
export { EGRESS_RULES, INJECTION_RULES } from './patterns';
export { GUARD_RULES_VERSION } from './version';

/** The outcome of one scan. No text: a source name and rule ids. */
export interface GuardCheck {
    readonly direction: GuardDirection;
    /** What was scanned, named by code: a data block's label, or `output`. */
    readonly source: string;
    readonly verdict: GuardVerdict;
    readonly action: GuardAction;
    readonly mode: GuardMode;
    /** Stable rule ids that fired. */
    readonly ruleIds: readonly string[];
}

/** One piece of author text to scan: a code-chosen label and the text. */
export interface GuardInput {
    readonly label: string;
    readonly text: string;
}

const VERDICT_RANK: Readonly<Record<GuardVerdict, number>> = { clean: 0, suspicious: 1, malicious: 2 };

/**
 * Scan every block of author text before it is placed in a prompt. One check
 * per block, over its text AND its label: a label is code-shaped
 * (`LABEL_PATTERN`) but is sent outside the fence, in the block's opening tag,
 * and a caller may build one from author-chosen words (an element's slug, say:
 * `ignore-previous-instructions` passes the pattern). Its separators are read
 * as spaces, so the rules' word boundaries see its words.
 */
export function guardAuthorText(blocks: readonly GuardInput[], mode: GuardMode = DEFAULT_GUARD_MODE): GuardCheck[] {
    return blocks.map((block) => {
        const text = scanInjection(block.text);
        const label = scanInjection(block.label.replace(/[._-]+/g, ' '));
        const verdict = VERDICT_RANK[label.verdict] > VERDICT_RANK[text.verdict] ? label.verdict : text.verdict;
        return {
            direction: 'input',
            source: block.label,
            verdict,
            action: resolveEnforcement(mode, verdict, 'input'),
            mode,
            ruleIds: [...new Set([...text.ruleIds, ...label.ruleIds])],
        };
    });
}

/** Scan the model's answer (any JSON-ish value) before it is handed back. */
export function guardModelOutput(value: unknown, mode: GuardMode = DEFAULT_GUARD_MODE): GuardCheck {
    const scan = scanEgress(value);
    return {
        direction: 'egress',
        source: 'output',
        verdict: scan.verdict,
        action: resolveEnforcement(mode, scan.verdict, 'egress'),
        mode,
        ruleIds: [...scan.ruleIds],
    };
}

/** What a set of checks amounts to: the first block, whether anything flagged, every rule id. */
export interface GuardSummary {
    readonly blocked: GuardCheck | null;
    readonly reviewRequired: boolean;
    readonly ruleIds: readonly string[];
}

export function summariseChecks(checks: readonly GuardCheck[]): GuardSummary {
    const blocked = checks.find((c) => c.action === 'block') ?? null;
    const reviewRequired = checks.some((c) => c.action !== 'allow');
    const ruleIds = [...new Set(checks.flatMap((c) => c.ruleIds))].sort();
    return { blocked, reviewRequired, ruleIds };
}
