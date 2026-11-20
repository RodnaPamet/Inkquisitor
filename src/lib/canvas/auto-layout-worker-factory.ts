/**
 * The layout worker's constructor (Phase 3.H). A module of its own because
 * `import.meta.url` is what tells the bundler to emit the worker's script as
 * a chunk, and Jest's CommonJS runtime cannot load a module that names it:
 * `auto-layout-off-thread.ts` imports this only in a browser that has a
 * `Worker`. The worker's response carries the static assets' policy
 * (`STATIC_ASSET_CSP`, `default-src 'none'`), so its script must load no
 * other script: it is one self-contained chunk (`next.config.mjs` keeps the
 * chunk named here out of Next's chunk splitting; the E2E arrange spec runs it
 * under that policy). Rename it in both places.
 */
import type { LayoutWorkerPort } from './auto-layout-off-thread';

export function createLayoutWorker(): LayoutWorkerPort {
    return new Worker(new URL('./auto-layout-worker.ts', import.meta.url), { name: 'story-map-layout' }) as unknown as LayoutWorkerPort;
}
