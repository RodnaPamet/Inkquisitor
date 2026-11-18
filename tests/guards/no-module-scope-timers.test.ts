/**
 * No `setInterval` in application code.
 *
 * An interval nothing clears holds its callback, and the callback holds its
 * module's scope, for the life of the process. Under Jest's in-band runner
 * every test file loads its own copy of each module, so one such interval in
 * a module keeps every importing test file's module graph alive to the end of
 * the run (inflect-compliance #4613: its rate limiter did exactly this). A
 * cache or a limiter here sweeps lazily, on a caller's turn
 * (`src/lib/security/rate-limit.ts`, `src/lib/rate-limit/window-store.ts`),
 * and a heartbeat is written from an event, not a timer
 * (`src/app-layer/jobs/heartbeat.ts`).
 *
 * Read with comments blanked (`codeOf`), so prose that names the API is fine.
 * The population is git's (`repoFiles`), never a hand-written skip list.
 */
import * as fs from 'node:fs';
import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const SOURCES = [
    ...repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }),
    ...repoFiles({ under: 'scripts', extensions: ['.ts', '.mjs'] }),
];

describe('no setInterval in application code', () => {
    it('scans a real population', () => {
        expect(SOURCES.map(repoRelative)).toEqual(
            expect.arrayContaining(['src/lib/security/rate-limit.ts', 'src/lib/rate-limit/window-store.ts', 'scripts/worker.ts']),
        );
    });

    it('no file calls setInterval', () => {
        const offenders = SOURCES.filter((f) => /\bsetInterval\s*\(/.test(codeOf(fs.readFileSync(f, 'utf8')))).map(repoRelative);
        expect(offenders).toEqual([]);
    });
});
