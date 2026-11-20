/**
 * `npm run packs:evaluate`'s options (Phase 2.3): a model run never writes
 * into the source tree, never runs without an explicit budget within the
 * maximum, and names the packs it covers.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EVAL_RUN_BUDGET_MAX_USD, metered, modelRunBudgetUsd, parseEvalArgs, runPackEvaluations, selectedPacks, summaryLines } from '@/lib/interview/evals/run-evaluations';
import { structuralGenerator, STRUCTURAL_GENERATOR_ID } from '@/lib/interview/evals/structural-generator';
import { getPacks, PACK_RECORD_FILE } from '@/lib/interview/packs';
import { fakeGenerator } from '../../helpers/fake-question-generator';

const packs = getPacks();

describe('the command line', () => {
    it('defaults to the structural generator over every pack, beside the packs', () => {
        expect(parseEvalArgs([])).toEqual({ generator: 'structural', packs: 'all', coverage: false, reconcile: false, out: null });
    });

    it('reads every option, in both spellings', () => {
        expect(parseEvalArgs(['--generator', 'model', '--out', 'evals-out', '--packs', 'craft-plot, persona-socratic', '--coverage', '--reconcile'])).toEqual({
            generator: 'model',
            packs: ['craft-plot', 'persona-socratic'],
            coverage: true,
            reconcile: true,
            out: 'evals-out',
        });
        expect(parseEvalArgs(['--generator=model', '--out=x', '--no-packs'])).toMatchObject({ generator: 'model', packs: [], out: 'x' });
    });

    it('a model run must name --out: its records never land in the source tree', () => {
        expect(() => parseEvalArgs(['--generator', 'model'])).toThrow(/--out/);
    });

    it('refuses what it does not know', () => {
        expect(() => parseEvalArgs(['--generator', 'fake'])).toThrow();
        expect(() => parseEvalArgs(['--surprise'])).toThrow(/unknown/);
        expect(() => parseEvalArgs(['--packs'])).toThrow(/value/);
        expect(() => selectedPacks(packs, ['craft-plot', 'craft-nothing'])).toThrow(/craft-nothing/);
        expect(selectedPacks(packs, 'all')).toHaveLength(21);
    });
});

describe('the budget', () => {
    it('must be set explicitly, above zero and at most the maximum', () => {
        expect(() => modelRunBudgetUsd({})).toThrow(/budget/);
        expect(() => modelRunBudgetUsd({ AI_MONTHLY_CEILING_USD_DEFAULT: '0' })).toThrow();
        expect(() => modelRunBudgetUsd({ AI_MONTHLY_CEILING_USD_DEFAULT: String(EVAL_RUN_BUDGET_MAX_USD + 1) })).toThrow();
        expect(() => modelRunBudgetUsd({ AI_MONTHLY_CEILING_USD_DEFAULT: 'lots' })).toThrow();
        expect(modelRunBudgetUsd({ AI_MONTHLY_CEILING_USD_DEFAULT: '5' })).toBe(5);
    });

    it('the meter adds what each call reports it cost', async () => {
        const spent = { microUsd: 0, calls: 0 };
        const gen = metered({ unavailableReason: () => null, generateCandidates: async () => ({ output: null, tokensUsed: 1, costMicroUsd: 1_500 }) }, spent);
        await gen.generateCandidates({} as never);
        await gen.generateCandidates({} as never);
        expect(spent).toEqual({ microUsd: 3_000, calls: 2 });
    });
});

describe('a model run’s budget is one month’s ceiling, so the run is held to its month', () => {
    it('a call asked for in the month the run started goes through; one in the next month stops the run with nothing sent', async () => {
        const { withinRunMonth } = await import('@/lib/interview/evals/run-evaluations');
        const { GenerationStop } = await import('@/lib/interview/generator');
        const inner = fakeGenerator();
        let clock = new Date('2026-11-30T23:59:58Z');
        const held = withinRunMonth(inner, new Date('2026-11-30T23:30:00Z'), () => clock);
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-evals-'));
        try {
            const before = await runPackEvaluations({ registry: packs, names: ['craft-mood'], generator: held, who: { kind: 'model', id: 'x' }, outRoot: out });
            expect(before[0].file).not.toBeNull();
            const sent = inner.calls.length;
            expect(sent).toBeGreaterThan(0);
            clock = new Date('2026-12-01T00:00:01Z');
            await expect(held.generateCandidates(inner.calls[0])).rejects.toBeInstanceOf(GenerationStop);
            const after = await runPackEvaluations({ registry: packs, names: ['craft-plot', 'craft-theme'], generator: held, who: { kind: 'model', id: 'x' }, outRoot: out });
            expect(after).toEqual([expect.objectContaining({ name: 'craft-plot', passed: false, file: null, error: expect.stringMatching(/^GenerationStop/) })]);
            expect(inner.calls).toHaveLength(sent);
        } finally {
            fs.rmSync(out, { recursive: true, force: true });
        }
    });

    it('the script holds the model generator to its month', () => {
        const script = fs.readFileSync(path.resolve(__dirname, '../../../scripts/evaluate-packs.ts'), 'utf8');
        expect(script).toMatch(/withinRunMonth\(model\.generator, new Date\(\)\)/);
    });
});

describe('a run', () => {
    it('writes each record under the output root, checked the way the mount gate checks it', async () => {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-evals-'));
        try {
            const results = await runPackEvaluations({ registry: packs, names: ['craft-mood', 'persona-socratic'], generator: structuralGenerator(), who: { kind: 'structural', id: STRUCTURAL_GENERATOR_ID }, outRoot: out });
            expect(results.map((r) => [r.name, r.passed])).toEqual([['craft-mood', true], ['persona-socratic', true]]);
            expect(fs.existsSync(path.join(out, 'craft/mood', PACK_RECORD_FILE))).toBe(true);
            expect(fs.existsSync(path.join(out, 'personas/socratic', PACK_RECORD_FILE))).toBe(true);
            expect(summaryLines(results, null, null).join('\n')).toMatch(/\| craft-mood \| yes \|/);
        } finally {
            fs.rmSync(out, { recursive: true, force: true });
        }
    });

    it('a failing generator’s record is written and reported as failing', async () => {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-evals-'));
        try {
            const [r] = await runPackEvaluations({ registry: packs, names: ['craft-mood'], generator: fakeGenerator({ fail: true }), who: { kind: 'model', id: 'down' }, outRoot: out });
            expect(r.passed).toBe(false);
            expect(r.failedCases.length).toBeGreaterThan(0);
        } finally {
            fs.rmSync(out, { recursive: true, force: true });
        }
    });

    it('a run that stops (the budget spent) writes nothing for that pack and runs no further pack', async () => {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-evals-'));
        try {
            const { GenerationStop } = await import('@/lib/interview/generator');
            const stopping = { unavailableReason: () => null, generateCandidates: async () => { throw new GenerationStop('WORKSPACE_CEILING', 'CEILING', null, 0); } };
            const results = await runPackEvaluations({ registry: packs, names: ['craft-mood', 'craft-plot'], generator: stopping, who: { kind: 'model', id: 'x' }, outRoot: out });
            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({ name: 'craft-mood', passed: false, file: null, error: expect.stringMatching(/^GenerationStop/) });
            expect(fs.existsSync(path.join(out, 'craft/mood', PACK_RECORD_FILE))).toBe(false);
        } finally {
            fs.rmSync(out, { recursive: true, force: true });
        }
    });
});
