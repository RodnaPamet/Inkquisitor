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
 * the worker cannot start or fails, the same pure function runs on the main
 * thread: a layout the author asked for is never refused. `thread` says where
 * it ran, which the tests read.
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

let nextJobId = 1;

function onMainThread(job: AutoLayoutJob): OffThreadLayout {
    const { positions } = computeAutoLayout(job.nodes, job.edges, job.direction, job.nodeIds ? new Set(job.nodeIds) : undefined);
    return { positions, thread: 'main' };
}

/** Lay `job` out in a worker when one can be had, else on the main thread. */
export async function layoutOffMainThread(job: AutoLayoutJob, createWorker: LayoutWorkerFactory = defaultLayoutWorker): Promise<OffThreadLayout> {
    let worker: LayoutWorkerPort | null = null;
    try {
        worker = await createWorker();
    } catch {
        worker = null;
    }
    if (!worker) return onMainThread(job);
    const id = nextJobId++;
    const port = worker;
    const answered = await new Promise<AutoLayoutReply | null>((resolve) => {
        port.onmessage = (event) => resolve(event.data?.id === id ? event.data : null);
        port.onerror = () => resolve(null);
        try {
            port.postMessage({ ...job, id });
        } catch {
            resolve(null);
        }
    });
    port.onmessage = null;
    port.onerror = null;
    port.terminate();
    if (!answered || 'failed' in answered) return onMainThread(job);
    return { positions: answered.positions, thread: 'worker' };
}
