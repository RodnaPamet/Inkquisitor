/**
 * The judge is an EVALUATION-TIME grader (Phase 2.H; issue #36, item 5): its
 * verdicts come from the Evals workflow, never from a product path. No module
 * the product runs — a route, a page, a usecase, a job, a component, the
 * proxy — may import it; only the evaluation runner and its script may.
 */
import * as fs from 'node:fs';
import { repoRelativeFiles } from '../helpers/repo-files';

const ALLOWED = new Set(['src/lib/evals/judge.ts', 'src/lib/interview/evals/run-evaluations.ts', 'scripts/evaluate-packs.ts']);

it('only the evaluation runner and its script import the judge', () => {
    const importers = repoRelativeFiles()
        .filter((rel) => /^(src|scripts)\/.*\.(ts|tsx|js|mjs)$/.test(rel))
        .filter((rel) => /from ['"](@\/lib\/evals\/judge|[./]+(lib\/)?evals\/judge)['"]|import\(['"][^'"]*evals\/judge['"]\)/.test(fs.readFileSync(rel, 'utf8')))
        .filter((rel) => !ALLOWED.has(rel));
    expect(importers).toEqual([]);
});

it('and the runner that imports it is reached by no product module', () => {
    const importers = repoRelativeFiles()
        .filter((rel) => /^src\/.*\.(ts|tsx)$/.test(rel) && !rel.startsWith('src/lib/interview/evals/') && !rel.startsWith('src/lib/evals/'))
        .filter((rel) => /evals\/run-evaluations['"]/.test(fs.readFileSync(rel, 'utf8')));
    expect(importers).toEqual([]);
});
