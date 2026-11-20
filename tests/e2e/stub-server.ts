/**
 * The second E2E server (Phase 2.4): the same production build, started with
 * the stubbed model (`AI_MODEL_STUB=1`, src/lib/ai/model-stub.ts) on a
 * loopback address, which production accepts only there. The suite's main
 * server keeps AI switched off; a spec that runs an interview end to end
 * (`test.use({ baseURL: STUB_BASE_URL })`) uses this one. Two above E2E_PORT:
 * the refusal spec's short-lived server is one above.
 */
export const STUB_PORT = Number(process.env.E2E_PORT || 3100) + 2;
export const STUB_BASE_URL = `http://localhost:${STUB_PORT}`;

/**
 * How long a spec waits for the setup sheet's options. The sheet reads
 * `GET interview-packs`, and the first read in a server process judges every
 * pack's evaluation record (2.3's mount gate replays each record: seconds on a
 * cold server, more beside parallel specs); later reads are cached.
 */
export const SETUP_OPTIONS_TIMEOUT_MS = 20_000;
