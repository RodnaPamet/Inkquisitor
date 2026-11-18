/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * Node runtime only (the edge runtime has neither pino, the OTel SDK nor
 * BullMQ). The test is written as `=== 'nodejs'` around a dynamic import
 * because Next replaces `process.env.NEXT_RUNTIME` at compile time: the edge
 * compilation sees `'edge' === 'nodejs'`, drops the branch, and never tries
 * to bundle the Node-only modules (Next's documented pattern).
 *
 * The work itself is in `src/instrumentation-node.ts`.
 */
export async function register(): Promise<void> {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { registerNode } = await import('./instrumentation-node');
        await registerNode();
    }
}
