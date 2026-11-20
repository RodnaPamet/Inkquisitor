/**
 * The `Injection red-team` workflow keeps the safety properties of `Evals`
 * (Phase 2.H, roadmap item 1; carved from inflect's garak.yml): nightly and on
 * a person's dispatch; the nightly off until the owner switches it on; the
 * secret, and a skip with a notice without it; a hard budget the runner also
 * enforces; read-only permissions; an artifact and nothing pushed or opened;
 * no CI check depends on it.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';
import { REDTEAM_BUDGET_DEFAULT_USD, REDTEAM_BUDGET_MAX_USD } from '@/lib/redteam/injection-suite';

const file = path.resolve(__dirname, '../../.github/workflows/injection-redteam.yml');
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
    on: { schedule?: Array<{ cron: string }>; workflow_dispatch?: { inputs?: Record<string, { default?: unknown; type?: string }> } };
    permissions: Record<string, string>;
    jobs: Record<string, { name: string; permissions?: unknown; steps: Step[]; env?: Record<string, string> }>;
}

const wf = parse(text) as Workflow;
const job = wf.jobs.redteam;

it('is named Injection red-team, one job, nightly and on dispatch with a budget input', () => {
    expect(wf.name).toBe('Injection red-team');
    expect(Object.keys(wf.jobs)).toEqual(['redteam']);
    expect(Object.keys(wf.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(wf.on.schedule).toHaveLength(1);
    expect(wf.on.schedule![0].cron).toMatch(/^([1-9]|[1-5]\d) \d{1,2} \* \* \*$/);
    expect(Object.keys(wf.on.workflow_dispatch!.inputs ?? {})).toEqual(['budget_usd']);
    expect(String(wf.on.workflow_dispatch!.inputs!.budget_usd.default)).toBe(String(REDTEAM_BUDGET_DEFAULT_USD));
});

it('holds contents: read and nothing else, and pushes, commits or opens nothing', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toBeUndefined();
    expect(text).not.toMatch(/:\s*write\b/);
    expect(text).not.toMatch(/\bgit (push|commit|add|tag)\b/);
    expect(text).not.toMatch(/\bgh (pr|issue|release|api)\b/);
    const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'))!;
    expect(checkout.with).toMatchObject({ 'persist-credentials': false });
    const upload = job.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))!;
    expect(String(upload.with!.path)).toContain('redteam-out/redteam-report.json');
    expect(upload.if).toMatch(/always\(\)/);
});

it('reads the key from secrets.ANTHROPIC_API_KEY only; skips with a notice without it, and a schedule without the owner’s switch', () => {
    const secrets = [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    expect(new Set(secrets)).toEqual(new Set(['ANTHROPIC_API_KEY']));
    const check = job.steps[0];
    expect(check).toMatchObject({ id: 'key', env: { KEY: '${{ secrets.ANTHROPIC_API_KEY }}', ENABLED: '${{ vars.INJECTION_REDTEAM_ENABLED }}' } });
    for (const step of job.steps.slice(1)) expect([step.name ?? step.uses, step.if]).toEqual([step.name ?? step.uses, expect.stringContaining("steps.key.outputs.present == 'true'")]);

    const run = (env: Record<string, string>) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-redteam-wf-'));
        try {
            const out = path.join(dir, 'out');
            fs.writeFileSync(out, '');
            const r = spawnSync('bash', ['-c', check.run!], { env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' });
            return { status: r.status, out: fs.readFileSync(out, 'utf8'), stdout: r.stdout };
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };
    expect(run({ KEY: '', ENABLED: 'true', EVENT: 'workflow_dispatch' })).toMatchObject({ status: 0, out: 'present=false\n' });
    expect(run({ KEY: 'k', ENABLED: '', EVENT: 'schedule' })).toMatchObject({ status: 0, out: 'present=false\n' });
    expect(run({ KEY: 'k', ENABLED: 'true', EVENT: 'schedule' })).toMatchObject({ status: 0, out: 'present=true\n' });
    expect(run({ KEY: 'k', ENABLED: '', EVENT: 'workflow_dispatch' })).toMatchObject({ status: 0, out: 'present=true\n' });
    expect(run({ KEY: '', ENABLED: '', EVENT: 'schedule' }).stdout).toMatch(/::notice::/);
});

it('runs the product’s red-team script with the budget as the workspace ceiling, capped at the runner’s own maximum', () => {
    const runStep = job.steps.find((s) => s.run?.includes('redteam:injection'))!;
    expect(runStep.env).toMatchObject({ ANTHROPIC_API_KEY: '${{ secrets.ANTHROPIC_API_KEY }}', AI_MONTHLY_CEILING_USD_DEFAULT: '${{ steps.inputs.outputs.budget }}' });
    const check = job.steps.find((s) => s.id === 'inputs')!;
    expect(check.run).toContain(`b <= ${REDTEAM_BUDGET_MAX_USD}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-redteam-budget-'));
    try {
        const out = path.join(dir, 'out');
        const budget = (b: string) => {
            fs.writeFileSync(out, '');
            return spawnSync('bash', ['-c', check.run!], { env: { PATH: process.env.PATH, BUDGET: b, GITHUB_OUTPUT: out } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' }).status;
        };
        expect(budget('2')).toBe(0);
        expect(fs.readFileSync(out, 'utf8')).toBe('budget=2\n');
        for (const bad of ['0', '11', '-1', '1e3', '$(id)', '']) expect([bad, budget(bad)]).toEqual([bad, 1]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

it('never interpolates an input, a variable or a step output into a shell script: they reach `run` through env', () => {
    for (const step of job.steps) {
        if (!step.run) continue;
        expect([step.name, step.run.match(/\$\{\{\s*(inputs|steps|github\.event|vars|secrets)\b[^}]*\}\}/g)]).toEqual([step.name, null]);
    }
});

it('is not part of CI: ci.yml neither names nor needs it', () => {
    const ci = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
    expect(ci).not.toMatch(/injection-redteam|redteam:injection/);
});
