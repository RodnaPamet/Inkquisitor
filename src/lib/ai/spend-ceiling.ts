/**
 * THE MONTHLY SPEND CEILING — check before a call, charge after.
 *
 * Modelled on inflect-compliance's `src/app-layer/ai/assistant/spend-ceiling.ts`
 * (see docs/carve-manifest.md), which states the WORST CASE a turn can cost,
 * derived from the live constants rather than written down, and uses UTF-8
 * bytes as the input bound because no model token is shorter than one byte.
 * Inflect's module states a bound and refuses nothing; this one refuses: a
 * call is admitted only when the scope's spend this month PLUS the call's
 * worst case stays within the ceiling. Checking the worst case, not an
 * estimate, is what makes the ceiling a ceiling: an admitted call cannot
 * overshoot it (concurrent calls aside; see below).
 *
 * ── THE SCOPE ───────────────────────────────────────────────────────────────
 *
 * Keyed by an opaque scope id and the UTC calendar month. The roadmap's scope
 * is the workspace (decision D4), which arrives with Phase 0.3; until then the
 * in-memory ceiling below is the only implementation and the caller names the
 * scope. The Prisma implementation (a monthly spend row per workspace, charged
 * with an atomic increment, the ceiling read from the workspace's settings)
 * implements the same interface.
 *
 * ── CONCURRENCY ─────────────────────────────────────────────────────────────
 *
 * `check` and `charge` are separate steps, so N concurrent calls that each
 * pass the check can together exceed the ceiling by at most N−1 worst cases.
 * The in-memory implementation is per process. The database implementation
 * should reserve the worst case atomically at check time and settle it on
 * charge; the interface leaves room for that (`charge` receives the reserved
 * worst case as well as the actual cost).
 */
import { env } from '@/env';

/** A ceiling of $20 a month per scope when the deployment sets none. */
export const DEFAULT_MONTHLY_CEILING_MICRO_USD = 20_000_000;

/** The UTC calendar month an instant falls in, `YYYY-MM`. */
export function spendPeriod(at: Date): string {
    return at.toISOString().slice(0, 7);
}

/** The deployment's per-scope monthly ceiling: `AI_WORKSPACE_MONTHLY_CEILING_USD`, else the default. */
export function configuredMonthlyCeilingMicroUsd(): number {
    const raw = env.AI_WORKSPACE_MONTHLY_CEILING_USD?.trim();
    if (!raw) return DEFAULT_MONTHLY_CEILING_MICRO_USD;
    const usd = Number(raw);
    return Number.isFinite(usd) && usd >= 0 ? Math.round(usd * 1_000_000) : DEFAULT_MONTHLY_CEILING_MICRO_USD;
}

export interface SpendCheck {
    readonly allowed: boolean;
    readonly period: string;
    readonly spentMicroUsd: number;
    readonly ceilingMicroUsd: number;
}

export interface SpendCeiling {
    /** May a call whose worst case is `worstCaseMicroUsd` start now? */
    check(scopeId: string, worstCaseMicroUsd: number, at: Date): Promise<SpendCheck>;
    /** Record what an admitted call actually cost (zero is allowed: a call that sent nothing). */
    charge(scopeId: string, charge: { costMicroUsd: number; worstCaseMicroUsd: number }, at: Date): Promise<void>;
}

/**
 * Per-process spend per scope per month. Entries for earlier months are
 * dropped lazily, on a caller's turn (no timer).
 */
export class InMemorySpendCeiling implements SpendCeiling {
    private readonly spent = new Map<string, number>();
    private currentPeriod: string | null = null;

    constructor(
        private readonly ceilingFor: (scopeId: string) => number = () => configuredMonthlyCeilingMicroUsd(),
    ) {}

    private key(scopeId: string, period: string): string {
        return `${period}\u0000${scopeId}`;
    }

    /** Drop the months before the newest one seen. `YYYY-MM` sorts as text. */
    private roll(period: string): void {
        if (this.currentPeriod !== null && period <= this.currentPeriod) return;
        this.currentPeriod = period;
        for (const k of [...this.spent.keys()]) {
            if (k.slice(0, 7) < period) this.spent.delete(k);
        }
    }

    async check(scopeId: string, worstCaseMicroUsd: number, at: Date): Promise<SpendCheck> {
        const period = spendPeriod(at);
        this.roll(period);
        const spentMicroUsd = this.spent.get(this.key(scopeId, period)) ?? 0;
        const ceilingMicroUsd = this.ceilingFor(scopeId);
        return {
            allowed: spentMicroUsd + worstCaseMicroUsd <= ceilingMicroUsd,
            period,
            spentMicroUsd,
            ceilingMicroUsd,
        };
    }

    async charge(scopeId: string, charge: { costMicroUsd: number }, at: Date): Promise<void> {
        const period = spendPeriod(at);
        this.roll(period);
        const k = this.key(scopeId, period);
        this.spent.set(k, (this.spent.get(k) ?? 0) + Math.max(0, Math.ceil(charge.costMicroUsd)));
    }

    /** This month's spend for a scope (tests, and a future usage page). */
    spentThisPeriod(scopeId: string, at: Date): number {
        return this.spent.get(this.key(scopeId, spendPeriod(at))) ?? 0;
    }
}
