/**
 * The layout worker's script (Phase 3.H): dagre off the main thread.
 *
 * It answers each job (`AutoLayoutJob`, with its id) with the positions
 * `computeAutoLayout` gives — the same pure function the main thread falls
 * back to — or `failed`, never a throw the page cannot see. It holds no
 * state between jobs and reads nothing but the message.
 *
 * `LAYOUT_WORKER_MARKER` is a string only this script carries, which
 * `scripts/check-build.js` looks for to hold the worker out of every route's
 * first load.
 */
import { computeAutoLayout } from './canvas-auto-layout';
import type { AutoLayoutJob, AutoLayoutReply } from './auto-layout-off-thread';

export const LAYOUT_WORKER_MARKER = 'inkquisitor:story-map-layout-worker';

interface WorkerScope {
    onmessage: ((event: { data: AutoLayoutJob & { id: number } }) => void) | null;
    postMessage(message: AutoLayoutReply & { worker: string }): void;
}

export function installLayoutWorker(scope: WorkerScope): void {
    scope.onmessage = (event) => {
        const { id, nodes, edges, direction, nodeIds } = event.data;
        try {
            const { positions } = computeAutoLayout(nodes, edges, direction, nodeIds ? new Set(nodeIds) : undefined);
            scope.postMessage({ id, positions, worker: LAYOUT_WORKER_MARKER });
        } catch {
            scope.postMessage({ id, failed: true, worker: LAYOUT_WORKER_MARKER });
        }
    };
}

// In a worker, `self` is the worker's global scope; anywhere else (a test
// importing this module) nothing is installed.
const workerGlobal = (globalThis as { WorkerGlobalScope?: new () => unknown }).WorkerGlobalScope;
if (workerGlobal !== undefined && globalThis instanceof workerGlobal) {
    installLayoutWorker(globalThis as unknown as WorkerScope);
}
