/**
 * The jsdom shims tldraw 3.15.6 needs in order to mount (Phase 3.1).
 *
 * Adapted from inflect-compliance's `tests/helpers/tldraw-jsdom.ts`
 * (docs/carve-manifest.md), each shim found there by mounting and reading
 * the error: `image.decode`, `fetch`, `document.fonts`, `FontFace`, and
 * `structuredClone` (dagre, through auto-layout).
 *
 * `fetch` is REPLACED, not only supplied when missing: tldraw fetches its
 * English translation from the asset route on mount, and a test must never
 * reach the network (a jsdom window's relative URL is localhost). The stub
 * answers 404, which tldraw meets by using its bundled English. Under jsdom
 * tldraw's licence manager reads the page as development and asks nothing.
 *
 * NOT a browser: no canvas 2D context, so geometry, hit-testing and drawing
 * belong to the Playwright suite. A green jsdom test proves wiring, never
 * pixels. Call `installTldrawJsdomShims()` at module scope, BEFORE importing
 * anything from `tldraw`.
 */
import * as v8 from 'node:v8';

let installed = false;

/** Every request a mounted tldraw made, for a test that asserts what it asked for. */
export const tldrawFetches: string[] = [];

export function installTldrawJsdomShims(): void {
    if (installed) return;
    installed = true;
    const g = globalThis as unknown as Record<string, unknown>;

    const image = HTMLImageElement.prototype as unknown as { decode?: unknown };
    if (typeof image.decode !== 'function') image.decode = () => Promise.resolve();

    const localFetch = (input: unknown) => {
        tldrawFetches.push(String(input));
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null), text: () => Promise.resolve(''), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    };
    Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: localFetch });
    g.fetch = localFetch;

    if (typeof g.structuredClone !== 'function') g.structuredClone = (value: unknown) => v8.deserialize(v8.serialize(value));

    if (typeof g.FontFace !== 'function') {
        g.FontFace = class FontFaceShim {
            constructor(readonly family: string) {}
            load() {
                return Promise.resolve(this);
            }
        };
    }

    const fonts = (document as unknown as { fonts?: { [Symbol.iterator]?: unknown } }).fonts;
    if (!fonts || typeof fonts[Symbol.iterator] !== 'function') {
        Object.defineProperty(document, 'fonts', {
            configurable: true,
            value: {
                ready: Promise.resolve(),
                add: () => {},
                delete: () => {},
                forEach: () => {},
                load: () => Promise.resolve([]),
                check: () => true,
                addEventListener: () => {},
                removeEventListener: () => {},
                [Symbol.iterator]: function* () {},
            },
        });
    }
}
