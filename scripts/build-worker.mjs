/**
 * Bundle the standalone worker entry points with esbuild.
 *
 * The runtime image prunes dev dependencies and carries no TypeScript, so it
 * cannot run scripts/*.ts. This bundles each entry point — with every `src/`
 * import inlined — into one `.mjs` under dist/. node_modules stay external,
 * resolved at run time from the pruned production install, so every package
 * the worker imports must be a production `dependency`.
 *
 *   dist/worker.mjs               the BullMQ worker  (node dist/worker.mjs)
 *   dist/worker-healthcheck.mjs   its container healthcheck
 *
 * Lifted from inflect-compliance's `scripts/build-worker.mjs`, cut to the two
 * entry points this repository has.
 */
import { build } from 'esbuild';

const common = {
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    // Every node_modules package stays external; only first-party code is inlined.
    packages: 'external',
    // Resolves the `@/*` path alias.
    tsconfig: 'tsconfig.json',
    logLevel: 'info',
    // ESM has no `require`, `__filename` or `__dirname`; an inlined module that
    // reaches for one gets it from here. `__dirname` is dist/, the bundle's
    // directory, not the source module's.
    banner: {
        js:
            "import { createRequire as __createRequire } from 'module';" +
            "import { dirname as __nodeDirname } from 'path';" +
            "import { fileURLToPath as __nodeFileURLToPath } from 'url';" +
            'const require = __createRequire(import.meta.url);' +
            'const __filename = __nodeFileURLToPath(import.meta.url);' +
            'const __dirname = __nodeDirname(__filename);',
    },
};

await build({ ...common, entryPoints: ['scripts/worker.ts'], outfile: 'dist/worker.mjs' });
await build({ ...common, entryPoints: ['scripts/worker-healthcheck.ts'], outfile: 'dist/worker-healthcheck.mjs' });
