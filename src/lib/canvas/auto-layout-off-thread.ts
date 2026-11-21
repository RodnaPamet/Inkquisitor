/**
 * Auto-layout OFF THE MAIN THREAD (Phase 3.H, item 2).
 *
 * dagre over a full map (500 nodes, 1,500 edges) is long enough work to
 * freeze the canvas while it runs, so "Arrange" hands the graph to a Web
 * Worker (`auto-layout-worker.ts`) and applies the positions it answers. The
 * worker is made per request and terminated after it, so nothing outlives a
 * layout, and it is loaded on demand: its factory is imported only once a
 * worker is wanted, and the worker's script is a chunk of its own, in no
 * route's first load (`scripts/check-build.js`, `ON_DEMAND_ONLY`).
 *
 * THE FALLBACK. Where no `Worker` exists (an old browser, a test's jsdom), or
 * the worker cannot start, fails, answers nothing within
 * `LAYOUT_WORKER_TIMEOUT_MS`, or answers something that is not a layout of
 * this job (a position that is not two finite numbers, or for a node the job
 * did not hold), the same pure function runs on the main thread: a layout the
 * author asked for is never refused, never waits for ever, and never writes
 * a worker's garbage into the store. `thread` says where it ran, which the
 * tests read.
 *
 * The request carries the positions and sizes only (plain data, structured
 * clone): ids, numbers and a direction — no author text, nothing a log would
 * need to redact.
 *
 * Client-safe, and free of `import.meta` so Jest can load it: the worker's
 * URL lives in `auto-layout-worker-factory.ts`, which only a browser imports.
 */
import { computeAutoLayout, type AutoLayoutDirection, type AutoLayoutResult, type LayoutEdge, type LayoutNode } from './canvas-auto-layout';

export interface AutoLayoutJob {
    nodes: LayoutNode[];
    edges: LayoutEdge[];
    direction: AutoLayoutDirection;
    /** Lay out only these node ids (arrange the selection); absent for the whole map. */
    nodeIds?: string[];
}

/** What the worker answers: the job's id and its positions, or that it failed. */
export type AutoLayoutReply = { id: number; positions: AutoLayoutResult['positions'] } | { id: number; failed: true };

/** The part of a `Worker` this module uses (a test hands in a fake). */
export interface LayoutWorkerPort {
    postMessage(message: AutoLayoutJob & { id: number }): void;
    terminate(): void;
    onmessage: ((event: { data: AutoLayoutReply }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    /** A reply that could not be deserialised (optional: a fake need not have it). */
    onmessageerror?: ((event: unknown) => void) | null;
}

export type LayoutWorkerFactory = () => Promise<LayoutWorkerPort | null>;

/** The browser's worker, or null where there is none (the factory module is imported only then). */
export const defaultLayoutWorker: LayoutWorkerFactory = async () => {
    if (typeof Worker === 'undefined') return null;
    try {
        const { createLayoutWorker } = await import('./auto-layout-worker-factory');
        return createLayoutWorker();
    } catch {
        return null;
    }
};

export interface OffThreadLayout extends AutoLayoutResult {
    /** Where the layout ran: a worker, or the main thread as the fallback. */
    thread: 'worker' | 'main';
}

/** How long a worker may take before the layout runs on the main thread instead (dagre over the bounds takes well under a second). */
export const LAYOUT_WORKER_TIMEOUT_MS = 15_000;

let nextJobId = 1;

/** The reply's positions when they are a layout of `job` (finite numbers, for its nodes only), else null. */
function positionsOf(reply: unknown, id: number, job: AutoLayoutJob): AutoLayoutResult['positions'] | null {
    if (typeof reply !== 'object' || reply === null) return null;
    const r = reply as { id?: unknown; positions?: unknown; failed?: unknown };
    if (r.id !== id || r.failed !== undefined) return null;
    if (typeof r.positions !== 'object' || r.positions === null || Array.isArray(r.positions)) return null;
    const ids = new Set(job.nodes.map((n) => n.id));
    const out: AutoLayoutResult['positions'] = {};
    for (const [key, value] of Object.entries(r.positions as Record<string, unknown>)) {
        if (!ids.has(key) || typeof value !== 'object' || value === null) return null;
        const { x, y } = value as { x?: unknown; y?: unknown };
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
        out[key] = { x, y };
    }
    return out;
}

function onMainThread(job: AutoLayoutJob): OffThreadLayout {
    const { positions } = computeAutoLayout(job.nodes, job.edges, job.direction, job.nodeIds ? new Set(job.nodeIds) : undefined);
    return { positions, thread: 'main' };
}

/** Lay `job` out in a worker when one can be had, else on the main thread. */
export async function layoutOffMainThread(
    job: AutoLayoutJob,
    createWorker: LayoutWorkerFactory = defaultLayoutWorker,
    timeoutMs: number = LAYOUT_WORKER_TIMEOUT_MS,
): Promise<OffThreadLayout> {
    let worker: LayoutWorkerPort | null = null;
    try {
        worker = await createWorker();
    } catch {
        worker = null;
    }
    if (!worker) return onMainThread(job);
    const id = nextJobId++;
    const port = worker;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = await new Promise<unknown>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        port.onmessage = (event) => resolve(event?.data ?? null);
        port.onerror = () => resolve(null);
        port.onmessageerror = () => resolve(null);
        try {
            port.postMessage({ ...job, id });
        } catch {
            resolve(null);
        }
    });
    clearTimeout(timer);
    port.onmessage = null;
    port.onerror = null;
    port.onmessageerror = null;
    try {
        port.terminate();
    } catch {
        // A worker that will not terminate is left to the page; its answer is not used.
    }
    const positions = positionsOf(answered, id, job);
    if (!positions) return onMainThread(job);
    return { positions, thread: 'worker' };
}
