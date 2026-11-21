/**
 * The layout worker's script (Phase 3.H): dagre off the main thread.
 *
 * It answers each job (`AutoLayoutJob`, with its id) with the positions
 * `computeAutoLayout` gives — the same pure function the main thread falls
 * back to — or `failed`, never a throw the page cannot see. It holds no
 * state between jobs, reads nothing but the message, and checks the message's
 * shape before it reads it (`jobOf`).
 *
 * `LAYOUT_WORKER_MARKER` is a string only this script carries, which
 * `scripts/check-build.js` looks for to hold the worker out of every route's
 * first load.
 */
import { computeAutoLayout } from './canvas-auto-layout';
import type { AutoLayoutJob, AutoLayoutReply } from './auto-layout-off-thread';

export const LAYOUT_WORKER_MARKER = 'inkquisitor:story-map-layout-worker';

interface WorkerScope {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage(message: AutoLayoutReply & { worker: string }): void;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optionalSize = (v: unknown) => v === undefined || finite(v);

/**
 * The job a message carries, when it is one: the shape is checked, never
 * assumed (a message is data, whoever posted it). Ids are strings, positions
 * and sizes finite numbers, the direction one of the two.
 */
export function jobOf(data: unknown): (AutoLayoutJob & { id: number }) | null {
    if (typeof data !== 'object' || data === null) return null;
    const d = data as { id?: unknown; nodes?: unknown; edges?: unknown; direction?: unknown; nodeIds?: unknown };
    if (!finite(d.id) || (d.direction !== 'LR' && d.direction !== 'TB') || !Array.isArray(d.nodes) || !Array.isArray(d.edges)) return null;
    for (const n of d.nodes as unknown[]) {
        if (typeof n !== 'object' || n === null) return null;
        const node = n as { id?: unknown; position?: { x?: unknown; y?: unknown } | null; width?: unknown; height?: unknown };
        if (typeof node.id !== 'string' || typeof node.position !== 'object' || node.position === null) return null;
        if (!finite(node.position.x) || !finite(node.position.y) || !optionalSize(node.width) || !optionalSize(node.height)) return null;
    }
    for (const e of d.edges as unknown[]) {
        if (typeof e !== 'object' || e === null || typeof (e as { source?: unknown }).source !== 'string' || typeof (e as { target?: unknown }).target !== 'string') return null;
    }
    if (d.nodeIds !== undefined && (!Array.isArray(d.nodeIds) || !(d.nodeIds as unknown[]).every((x) => typeof x === 'string'))) return null;
    return data as AutoLayoutJob & { id: number };
}

export function installLayoutWorker(scope: WorkerScope): void {
    scope.onmessage = (event) => {
        const job = jobOf(event?.data);
        if (!job) {
            // Not a job: answered as failed under its id when it has one (the page then lays out itself), never thrown.
            const id = (event?.data as { id?: unknown } | null | undefined)?.id;
            if (finite(id)) scope.postMessage({ id, failed: true, worker: LAYOUT_WORKER_MARKER });
            return;
        }
        try {
            const { positions } = computeAutoLayout(job.nodes, job.edges, job.direction, job.nodeIds ? new Set(job.nodeIds) : undefined);
            scope.postMessage({ id: job.id, positions, worker: LAYOUT_WORKER_MARKER });
        } catch {
            scope.postMessage({ id: job.id, failed: true, worker: LAYOUT_WORKER_MARKER });
        }
    };
}

// In a worker, `self` is the worker's global scope; anywhere else (a test
// importing this module) nothing is installed.
const workerGlobal = (globalThis as { WorkerGlobalScope?: new () => unknown }).WorkerGlobalScope;
if (workerGlobal !== undefined && globalThis instanceof workerGlobal) {
    installLayoutWorker(globalThis as unknown as WorkerScope);
}
