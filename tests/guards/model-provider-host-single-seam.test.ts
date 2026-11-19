/**
 * Roadmap rule 3, the half the ESLint rule cannot see: no module but the seam
 * names the model provider's API host.
 *
 * `local/anthropic-client-single-seam` refuses every load of the SDK outside
 * `src/lib/ai/client.ts`. A module that called the Messages API with a plain
 * `fetch` would load no SDK and so pass the rule, and it would skip
 * everything the seam enforces: the kill switch, the zero-retention check,
 * the messages-only middleware, the call record and the spend ceiling. So the
 * host itself is held to the seam: under `src/` and `scripts/`, only the seam
 * may spell `anthropic.com`, in any case and with any subdomain.
 *
 * The population is git's (`repoFiles`), never a hand-written skip list.
 */
import * as fs from 'node:fs';
import { repoFiles, repoRelative } from '../helpers/repo-files';

const SEAM = 'src/lib/ai/client.ts';
// A substring search over source text, not a URL check: any mention of the
// host, in any case and under any subdomain, counts.
const HOST = 'anthropic.com';
const namesHost = (text: string): boolean => text.toLowerCase().includes(HOST);

const SOURCES = [...repoFiles({ under: 'src' }), ...repoFiles({ under: 'scripts' })];

it('the population is real: the seam itself is read and does name the host', () => {
    expect(SOURCES.map(repoRelative)).toContain(SEAM);
    expect(namesHost(fs.readFileSync(SOURCES.find((f) => repoRelative(f) === SEAM)!, 'utf8'))).toBe(true);
    expect(SOURCES.length).toBeGreaterThan(100);
});

it('no other module under src/ or scripts/ names the provider’s host', () => {
    const offenders = SOURCES.filter((file) => repoRelative(file) !== SEAM && namesHost(fs.readFileSync(file, 'utf8'))).map(repoRelative);
    expect(offenders).toEqual([]);
});
