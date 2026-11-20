/**
 * No module a client component can reach imports the model layer
 * (`src/lib/ai/**`): the one file that loads the SDK (`client.ts`), its
 * configuration, and above all the stubbed model (`model-stub.ts`, Phase 2.4,
 * decision D13), which must never be in a browser bundle — a stub a client
 * chunk carried would be a model answer the browser could fabricate, and its
 * refusal sentences name server variables (`scripts/check-build.js` would
 * fail the build on them; this says why, at the edge that brought it in).
 *
 * NO ALLOWLIST: the interview UI reaches the model only through its routes.
 */
import * as path from 'node:path';
import { bundledSpecifiers, clientRoots, reachFrom } from '../helpers/client-import-graph';
import { REPO_ROOT, repoRelative } from '../helpers/repo-files';

const MODEL_LAYER = path.join(REPO_ROOT, 'src/lib/ai') + path.sep;
const STUB = path.join(REPO_ROOT, 'src/lib/ai/model-stub.ts');

describe('a client-reachable module reaches no model-layer module', () => {
    const { reached, via } = reachFrom(clientRoots());

    it('no file under src/lib/ai is reachable from a `use client` file', () => {
        const hits = [...reached.keys()].filter((f) => f.startsWith(MODEL_LAYER)).map((f) => `${repoRelative(f)} via ${via(f)}`);
        expect(hits).toEqual([]);
    });

    it('in particular, not the stubbed model', () => {
        expect(reached.has(STUB)).toBe(false);
    });

    it('would see the stub reached through a helper (an in-memory proof of the edges it follows)', () => {
        expect(bundledSpecifiers("import { stubMessagesFetch } from '@/lib/ai/model-stub';", 'x.ts')).toEqual(['@/lib/ai/model-stub']);
        expect(bundledSpecifiers("import type { AiEnvRecord } from '@/lib/ai/config';", 'x.ts')).toEqual([]);
        // The walk reaches the interview UI's own helpers, so an import added there would be seen.
        expect(reached.has(path.join(REPO_ROOT, 'src/lib/interview/setup.ts'))).toBe(true);
    });
});
