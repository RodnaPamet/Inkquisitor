/**
 * THE GUARD'S RULE VERSION (Phase 4.H-b, decision D32).
 *
 * A number that changes whenever what the guard refuses can change: its rule
 * table (`patterns.ts`), the normalisation the rules match against
 * (`normalize.ts`), the two scanners (`injection-scanner.ts`,
 * `egress-scanner.ts`), the enforcement table (`policy.ts`), how a block's
 * text and label combine into a verdict (`index.ts`) and every module those
 * import (`src/lib/text/invisible-chars.ts` today). Bible fact
 * extraction records, for each section the guard refused, the version that
 * refused it (`BibleFactExtraction.guardRefused`); once this number is newer
 * than the one recorded, the section is sent again ONCE, and the baseline moves
 * past it again if the new rules refuse it too.
 *
 * `tests/unit/ai/guard-rules-version.test.ts` hashes those files (and holds
 * the list to the guard's import graph) and fails when they change without
 * this number moving: bump it by one and record the new hash beside it there,
 * in the same change.
 */
export const GUARD_RULES_VERSION = 1;
