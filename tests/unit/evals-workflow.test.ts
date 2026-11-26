/**
 * The `Evals` workflow keeps its shape (Phase 2.3; owner decisions of
 * 2026-11-19): real-model evaluation records are made in GitHub Actions, on
 * the repository secret ANTHROPIC_API_KEY, by a person's dispatch only; with
 * no key it skips with a notice and never falls back to the structural
 * generator; it holds read-only permissions, pushes and commits nothing,
 * uploads the records as an artifact, and runs under a hard budget the runner
 * also enforces. It is no CI check, and no CI job is renamed for it.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';
import { EVAL_RUN_BUDGET_MAX_USD } from '@/lib/interview/evals/run-evaluations';

const file = path.resolve(__dirname, '../../.github/workflows/evals.yml');
const text = fs.readFileSync(file, 'utf8');

interface Step {
    name?: string;
    id?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
}
interface Workflow {
    name: string;
    on: Record<string, { inputs?: Record<string, { default?: unknown; type?: string }> }>;
    permissions: Record<string, string>;
    jobs: Record<string, { name: string; permissions?: unknown; steps: Step[]; env?: Record<string, string> }>;
}

const wf = parse(text) as Workflow;
const job = wf.jobs.evals;

describe('.github/workflows/evals.yml', () => {
    it('parses, and is named Evals with one job', () => {
        expect(wf.name).toBe('Evals');
        expect(Object.keys(wf.jobs)).toEqual(['evals']);
    });

    it('runs only when a person dispatches it, with packs, coverage, reconcile, research, rephrase, sources, bible facts, continuity, book-level and budget inputs (at most ten: GitHub’s limit)', () => {
        expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
        expect(Object.keys(wf.on.workflow_dispatch.inputs ?? {})).toEqual(['packs', 'coverage', 'reconcile', 'research', 'rephrase', 'sources', 'bible_facts', 'continuity', 'book_level', 'budget_usd']);
        expect(Object.keys(wf.on.workflow_dispatch.inputs ?? {}).length).toBeLessThanOrEqual(10);
        expect(wf.on.workflow_dispatch.inputs!.research.type).toBe('boolean');
        expect(wf.on.workflow_dispatch.inputs!.coverage.type).toBe('boolean');
        expect(wf.on.workflow_dispatch.inputs!.reconcile.type).toBe('boolean');
    });

    it('runs the reconcile sets (Phase 2.5) on the same model path, its record uploaded with the packs’ (evals-out/**)', () => {
        const run = job.steps.find((s) => s.run?.includes('packs:evaluate'))!;
        expect(run.env).toMatchObject({ RECONCILE: '${{ inputs.reconcile }}' });
        expect(run.run).toMatch(/if \[ "\$RECONCILE" = "true" \]; then extra="\$extra --reconcile"; fi/);
        const upload = job.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))!;
        expect(String(upload.with!.path)).toContain('evals-out/**/evaluation-record.json');
    });

    it('runs the rephrase set (Phase 2.H) on the same model path, its record uploaded with the others', () => {
        expect(wf.on.workflow_dispatch.inputs!.rephrase.type).toBe('boolean');
        const run = job.steps.find((s) => s.run?.includes('packs:evaluate'))!;
        expect(run.env).toMatchObject({ REPHRASE: '${{ inputs.rephrase }}' });
        expect(run.run).toMatch(/if \[ "\$REPHRASE" = "true" \]; then extra="\$extra --rephrase"; fi/);
    });

    it('runs the book-level interrogation sets (Phase 4.3: stress test, gap ranking, rounds summary) on the same model path', () => {
        expect(wf.on.workflow_dispatch.inputs!.book_level.type).toBe('boolean');
        expect(wf.on.workflow_dispatch.inputs!.book_level.default).toBe(false);
        const run = job.steps.find((s) => s.run?.includes('packs:evaluate'))!;
        expect(run.env).toMatchObject({ BOOK_LEVEL: '${{ inputs.book_level }}' });
        // Phase 4.4: the same input runs the interview tie-break's set (the dispatch form holds at most ten inputs).
        expect(run.run).toMatch(/if \[ "\$BOOK_LEVEL" = "true" \]; then extra="\$extra --book-level --question-order"; fi/);
    });

    it('runs the deep continuity check’s set (Phase 4.2) on the same model path, its record uploaded with the others', () => {
        expect(wf.on.workflow_dispatch.inputs!.continuity.type).toBe('boolean');
        expect(wf.on.workflow_dispatch.inputs!.continuity.default).toBe(false);
        const run = job.steps.find((s) => s.run?.includes('packs:evaluate'))!;
        expect(run.env).toMatchObject({ CONTINUITY: '${{ inputs.continuity }}' });
        expect(run.run).toMatch(/if \[ "\$CONTINUITY" = "true" \]; then extra="\$extra --continuity"; fi/);
    });

    it('runs bible fact extraction’s set (Phase 4.1) on the same model path, its record uploaded with the others', () => {
        expect(wf.on.workflow_dispatch.inputs!.bible_facts.type).toBe('boolean');
        expect(wf.on.workflow_dispatch.inputs!.bible_facts.default).toBe(false);
        const run = job.steps.find((s) => s.run?.includes('packs:evaluate'))!;
        expect(run.env).toMatchObject({ BIBLE_FACTS: '${{ inputs.bible_facts }}' });
        expect(run.run).toMatch(/if \[ "\$BIBLE_FACTS" = "true" \]; then extra="\$extra --bible-facts"; fi/);
    });

    it('runs source fact extraction’s set (Phase 4.0) on the same model path, its record uploaded with the others', () => {
        expect(wf.on.workflow_dispatch.inputs!.sources.type).toBe('boolean');
        expect(wf.on.workflow_dispatch.inputs!.sources.default).toBe(false);
        const run = job.steps.find((s) => s.run?.includes('packs:evaluate'))!;
        expect(run.env).toMatchObject({ SOURCES: '${{ inputs.sources }}' });
        expect(run.run).toMatch(/if \[ "\$SOURCES" = "true" \]; then extra="\$extra --sources"; fi/);
        const upload = job.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))!;
        expect(String(upload.with!.path)).toContain('evals-out/**/evaluation-record.json');
    });

    it('runs the judge over the ungraded behaviours on every model run, its report uploaded (Phase 2.H)', () => {
        const run = job.steps.find((s) => s.run?.includes('packs:evaluate'))!;
        expect(run.run).toMatch(/npm run packs:evaluate -- --generator model --out evals-out --judge /);
        const upload = job.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))!;
        expect(String(upload.with!.path)).toContain('evals-out/judge-report.json');
    });

    it('runs the research sets (Phase 2.6) on the same model path, its record uploaded with the others', () => {
        const run = job.steps.find((s) => s.run?.includes('packs:evaluate'))!;
        expect(run.env).toMatchObject({ RESEARCH: '${{ inputs.research }}' });
        expect(run.run).toMatch(/if \[ "\$RESEARCH" = "true" \]; then extra="\$extra --research"; fi/);
    });

    it('holds contents: read and nothing else, at every level', () => {
        expect(wf.permissions).toEqual({ contents: 'read' });
        expect(job.permissions).toBeUndefined();
        expect(text).not.toMatch(/:\s*write\b/);
    });

    it('pushes, commits and opens nothing: the records are an artifact a person reviews', () => {
        expect(text).not.toMatch(/\bgit (push|commit|add|tag)\b/);
        expect(text).not.toMatch(/\bgh (pr|release|api)\b/);
        expect(text).not.toMatch(/create-pull-request|git-auto-commit/);
        const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'))!;
        expect(checkout.with).toMatchObject({ 'persist-credentials': false });
        const upload = job.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))!;
        expect(String(upload.with!.path)).toMatch(/evaluation-record\.json/);
        expect(upload.if).toMatch(/always\(\)/);
    });

    it('reads the key from secrets.ANTHROPIC_API_KEY only, and skips with a notice when it is absent', () => {
        const secrets = [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
        expect(new Set(secrets)).toEqual(new Set(['ANTHROPIC_API_KEY']));
        const check = job.steps[0];
        expect(check).toMatchObject({ id: 'key', env: { KEY: '${{ secrets.ANTHROPIC_API_KEY }}' } });
        expect(check.run).toMatch(/if \[ -z "\$KEY" \]/);
        expect(check.run).toMatch(/::notice::/);
        expect(check.run).toMatch(/present=false/);
        expect(check.run).not.toMatch(/exit 1/);
        // Every later step waits on the key.
        for (const step of job.steps.slice(1)) expect([step.name ?? step.uses, step.if]).toEqual([step.name ?? step.uses, expect.stringContaining("steps.key.outputs.present == 'true'")]);
    });

    it('runs the model path and never the structural generator', () => {
        const run = job.steps.find((s) => s.run?.includes('packs:evaluate'))!;
        expect(run.run).toMatch(/--generator model/);
        expect(text).not.toMatch(/--generator structural/);
        expect(run.env).toMatchObject({ ANTHROPIC_API_KEY: '${{ secrets.ANTHROPIC_API_KEY }}', AI_MONTHLY_CEILING_USD_DEFAULT: '${{ inputs.budget_usd }}' });
        expect(run.run).toMatch(/--out evals-out/);
    });

    it('caps the budget at the runner’s own maximum, in the input check', () => {
        const check = job.steps.find((s) => s.id === 'inputs')!;
        expect(check.run).toContain(`b <= ${EVAL_RUN_BUDGET_MAX_USD}`);
        expect(String(wf.on.workflow_dispatch.inputs!.budget_usd.default)).toBe('5');
    });

    it('never interpolates an input or a step output into a shell script: they reach `run` through env', () => {
        for (const step of job.steps) {
            if (!step.run) continue;
            expect([step.name, step.run.match(/\$\{\{\s*(inputs|steps|github\.event|vars|secrets)\b[^}]*\}\}/g)]).toEqual([step.name, null]);
        }
    });

    it('accepts only pack names, all or none as the packs input: nothing that reaches the runner as an option', () => {
        const check = job.steps.find((s) => s.id === 'inputs')!;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-evals-wf-'));
        try {
            const run = (packs: string) => {
                const out = path.join(dir, 'out');
                fs.writeFileSync(out, '');
                const r = spawnSync('bash', ['-c', check.run!], { env: { PATH: process.env.PATH, PACKS: packs, BUDGET: '5', GITHUB_OUTPUT: out } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' });
                return { status: r.status, out: fs.readFileSync(out, 'utf8') };
            };
            expect(run('all')).toEqual({ status: 0, out: 'args=--packs all\n' });
            expect(run('none')).toEqual({ status: 0, out: 'args=--no-packs\n' });
            expect(run('craft-character,persona-socratic')).toEqual({ status: 0, out: 'args=--packs craft-character,persona-socratic\n' });
            for (const bad of ['--out', '-x', 'all,--coverage', 'craft-character --out /tmp', 'a;b', '$(id)', '']) expect([bad, run(bad).status]).toEqual([bad, 1]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('is not part of CI: ci.yml neither names nor needs it', () => {
        const ci = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
        expect(ci).not.toMatch(/evals\.yml|packs:evaluate/);
    });
});
