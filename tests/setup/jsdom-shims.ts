/**
 * Shared jsdom shims for the `rendered` Jest project.
 *
 * `tests/rendered/setup.ts` (the `rendered` project's
 * `setupFilesAfterEnv`) imports this at the top, so the RTL suites pick up
 * the shims before the axe / testing-library bootstrap. The `unit` and
 * `integration` projects do not load it.
 *
 * Every shim is feature-detected, so the file is safe to load in a
 * pure-node environment too.
 */

// Default per-test timeout for the `rendered` project. Jest's 5s default is
// too tight for heavy render tests under full-suite parallel load — they pass
// solo but starve when the whole suite runs. 30s gives realistic headroom
// without masking a genuine hang. A project-level `testTimeout` in
// jest.config is IGNORED, so it must be set here. A per-file
// `jest.setTimeout(...)` still overrides this.
jest.setTimeout(30_000);

if (typeof window !== 'undefined') {
    // motion-dom's KeyframesResolver.measureAllKeyframes probes
    // `window.scrollTo` on each animation-frame tick. jsdom's default
    // throws "Not implemented", which spams console.error in any
    // render test that mounts a <motion.*> component or anything
    // transitively animated by `motion` (TrendCard, Accordion, Modal,
    // Sheet, micro-visuals). defineProperty is used so we override
    // jsdom's prototype-level method on the instance even if jsdom
    // exposes it as a non-writable descriptor.
    Object.defineProperty(window, 'scrollTo', {
        value: () => {},
        writable: true,
        configurable: true,
    });
}
