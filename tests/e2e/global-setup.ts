/**
 * Warms each E2E server's cold routes before the first spec (issue #36, item 8).
 *
 * THE CAUSE of the `auth.spec.ts` cold-start timeouts, measured on
 * 2026-11-20. Readiness (`/api/health`) waits only for Next's preparation (the
 * instrumentation hook); `next start` loads a route's server chunk on that
 * route's FIRST request — the sign-up page answered in 226 ms cold and 17 ms
 * warm, and each first route pays the like. Each worker's first spec is a
 * sign-up, whose own work is the larger part and cannot be warmed: two bcrypt
 * operations at cost 12 (about 0.27 s each), the workspace's data key,
 * NextAuth's credential round trips and the workspace page's first render. A
 * whole sign-up spec takes 4.6–5.2 s with two workers, three servers and a
 * worker process sharing the machine; on a loaded two-core runner its sign-up
 * step crossed the old 5 s expectation once. The fix is twofold: the sign-up
 * helper's budget (20 s since 2.5) covers the work, and this warm-up removes
 * the cold-route share before any spec, so it is never paid on the clock.
 *
 * So the public routes the first specs hit are requested once here, after the
 * web servers are up and before any spec: their chunks are loaded off the
 * clock. A request that fails is not an error here (the specs will say what is
 * wrong); this is a warm-up, never a gate. The sign-up helper keeps its own
 * 20 s budget for the work that cannot be warmed (hashing, the data key).
 */
import { STUB_BASE_URL } from './stub-server';

const ROUTES = ['/', '/login', '/signup', '/no-workspace', '/api/health', '/api/auth/csrf', '/api/auth/session'];

export default async function globalSetup(): Promise<void> {
    if (process.env.URL) return; // an already-running server is the caller's
    const port = Number(process.env.E2E_PORT || 3100);
    for (const base of [`http://localhost:${port}`, STUB_BASE_URL]) {
        for (const route of ROUTES) {
            try {
                await fetch(`${base}${route}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
            } catch {
                // A warm-up only: the specs report a server that does not answer.
            }
        }
    }
}
