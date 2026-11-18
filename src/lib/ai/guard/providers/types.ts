/**
 * AI Guard — the `GuardProvider` seam.
 *
 * Lifted from inflect-compliance's `src/app-layer/ai/guard/providers/types.ts`
 * (see docs/carve-manifest.md), where it was built for a second, remote guard
 * (NeMo Guardrails). Inkquisitor carries the seam and one provider, the
 * deterministic `patterns` provider; the remote provider and its registry are
 * not carried.
 *
 * A provider answers one question about one piece of content: what verdict
 * does it earn, and which of the provider's rules fired. It answers nothing
 * else. It holds no permission check, no usecase call, no Prisma call and no
 * guard mode: the mode and the enforcement action are decided ONCE, above the
 * providers, in `../index.ts`. That keeps every provider a pure verdict
 * source, and it is what lets `compose.ts` combine them by verdict alone.
 *
 * `scan` never makes a model call and never "answers" the content — a guard
 * that produced text would be a second model route nobody chose.
 */
import type { ScanResult } from '../injection-scanner';
import type { GuardVerdict } from '../injection-scanner';
import type { GuardDirection } from '../policy';

/** Which side of the boundary the content is crossing. Same values as `GuardDirection`. */
export type GuardScanKind = GuardDirection;

/**
 * What a provider may know about the call. Deliberately narrow: a provider
 * has no business reading a role, a workspace or the guard mode.
 */
export interface GuardProviderContext {
    /** The model call this scan belongs to, for correlation only. */
    readonly callId: string;
}

export interface GuardProvider {
    /** Stable, lower-case id. Used to namespace rule ids of every provider but `patterns`. */
    readonly id: string;
    /**
     * True when a scan waits on the network. Required, so a new provider has to
     * say which it is rather than inherit an answer. Only in-process providers
     * exist today.
     */
    readonly remote: boolean;
    /**
     * Scan the content. `input` content is author text on its way into a
     * model; `egress` content is an arbitrary JSON-ish payload on its way out.
     *
     * A provider SHOULD NOT throw — it should return its own unavailable
     * verdict — but `compose.ts` treats a throw, a rejected promise or a
     * malformed result as the provider being unavailable, so one that does
     * throw fails closed rather than open.
     */
    scan(kind: GuardScanKind, content: unknown, ctx: GuardProviderContext): Promise<ScanResult>;
}

/** The verdict vocabulary, in severity order. Shared by compose and its tests. */
export const GUARD_VERDICTS: readonly GuardVerdict[] = ['clean', 'suspicious', 'malicious'];
