/**
 * How many streams may be open at once (Phase 2.H item 4; issue #36, item 3).
 *
 * Adapted from inflect-compliance's
 * `src/app-layer/ai/assistant/stream-capacity.ts` (see docs/carve-manifest.md):
 * keyed by workspace rather than tenant, the shutdown cut not carried.
 *
 * ═══ WHY A STREAM NEEDS ITS OWN BOUND ═══
 *
 * The mutation rate limit bounds REQUESTS per client address. A stream is a
 * different cost: it HOLDS a connection, and for an interview round a model
 * call, for its whole life, in the same Node process as every other route.
 * The round's GENERATING claim allows one generation per SESSION; nothing
 * else stopped one workspace opening a stream on every session it has (or
 * a research progress stream per run) and filling the process.
 *
 * Two bounds, because they fail differently: the per-workspace one stops one
 * author monopolising the process; the global one stops the sum of
 * well-behaved workspaces doing the same.
 *
 * ═══ IN-PROCESS, AND SAYING SO ═══
 *
 * The counters live in module scope, so they bound ONE Node process — which
 * is the resource being protected (this process's connections). On a second
 * web process each admits its own allowance; it is not a workspace-wide
 * quota across processes and must not be described as one. The upgrade path
 * is a shared counter (Redis), not a larger number here.
 *
 * A slot is taken BEFORE the stream's work starts and released exactly once
 * however it ends: the run settling, the client going away, the reader
 * cancelling, or a refusal before the stream opened. Cancellation therefore
 * frees the slot (2.H item 4), and `streamCapacitySnapshot` lets a test see it.
 */

/** Per workspace. An author has one interview page and a research page open at most, normally. */
export const MAX_STREAMS_PER_WORKSPACE = 4;

/** Across all workspaces in this process. */
export const MAX_STREAMS_GLOBAL = 32;

const perWorkspace = new Map<string, number>();
let total = 0;

export type CapacityRefusal = 'WORKSPACE_AT_CAPACITY' | 'PROCESS_AT_CAPACITY';

export interface CapacityLease {
    /** Idempotent: the release paths overlap (an abort and the run's end), and a double decrement would leak capacity upward. */
    release(): void;
}

/**
 * Take a slot, or refuse naming the bound that is binding (one noisy
 * workspace, or a full process, need different operator actions). Refuses the
 * N+1 rather than degrading the N already open.
 */
export function acquireStreamSlot(workspaceId: string): CapacityLease | CapacityRefusal {
    if (total >= MAX_STREAMS_GLOBAL) return 'PROCESS_AT_CAPACITY';
    const held = perWorkspace.get(workspaceId) ?? 0;
    if (held >= MAX_STREAMS_PER_WORKSPACE) return 'WORKSPACE_AT_CAPACITY';
    perWorkspace.set(workspaceId, held + 1);
    total += 1;
    let released = false;
    return {
        release: () => {
            if (released) return;
            released = true;
            total -= 1;
            const now = (perWorkspace.get(workspaceId) ?? 1) - 1;
            if (now <= 0) perWorkspace.delete(workspaceId);
            else perWorkspace.set(workspaceId, now);
        },
    };
}

/** For tests and diagnostics. Never used to make a decision. */
export function streamCapacitySnapshot(): { total: number; workspaces: Record<string, number> } {
    return { total, workspaces: Object.fromEntries(perWorkspace) };
}

/** Test-only reset, so one suite's leaked slot cannot fail the next. */
export function __resetStreamCapacity(): void {
    perWorkspace.clear();
    total = 0;
}
