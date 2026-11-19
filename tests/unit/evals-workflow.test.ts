/**
 * The `Evals` workflow keeps its shape (Phase 2.3; owner decisions of
 * 2026-11-19): real-model evaluation records are made in GitHub Actions, on
 * the repository secret ANTHROPIC_API_KEY, by a person's dispatch only; with
 * no key it skips with a notice and never falls back to the structural
 * generator; it holds read-only permissions, pushes and commits nothing,
 * uploads the records as an artifact, and runs under a hard budget the runner
 * also enforces. It is no CI check, and no CI job is renamed for it.
 */
import * as fs from 'node:fs';
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

    it('runs only when a person dispatches it, with packs, coverage and budget inputs', () => {
        expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
        expect(Object.keys(wf.on.workflow_dispatch.inputs ?? {})).toEqual(['packs', 'coverage', 'budget_usd']);
        expect(wf.on.workflow_dispatch.inputs!.coverage.type).toBe('boolean');
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

    it('is not part of CI: ci.yml neither names nor needs it', () => {
        const ci = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
        expect(ci).not.toMatch(/evals\.yml|packs:evaluate/);
    });
});
