/**
 * Every model feature's D11 gate is reported at start (Phase 4.H-a, #63).
 * Until 4.H-a only the reconcile step's report was read, so a production
 * deployment with no record for the continuity check, the stress test, the gap
 * ranking or the tie-break said nothing until an author asked why the feature
 * did nothing.
 */
jest.mock('@/lib/startup-checks', () => ({ enforceProductionConfig: jest.fn() }));
jest.mock('@/lib/security/encryption-sentinel', () => ({ runEncryptionSentinel: jest.fn() }));
jest.mock('@/lib/observability/instrumentation', () => ({ initTelemetry: jest.fn() }));
jest.mock('@/lib/observability/sentry', () => ({ initSentry: jest.fn() }));
jest.mock('@/lib/mailer', () => ({ initMailerFromEnv: jest.fn() }));
jest.mock('@/lib/observability/shutdown', () => ({ installShutdownHandlers: jest.fn() }));

import { repoRelativeFiles } from '../../helpers/repo-files';
import { registerNode } from '@/instrumentation-node';
import { GATE_REPORTS, recordGateReports } from '@/lib/evals/record-gate-reports';

const env = process.env as Record<string, string | undefined>;
const saved = { NODE_ENV: env.NODE_ENV, NEXT_PHASE: env.NEXT_PHASE };

afterEach(() => {
    env.NODE_ENV = saved.NODE_ENV;
    if (saved.NEXT_PHASE === undefined) delete env.NEXT_PHASE;
    else env.NEXT_PHASE = saved.NEXT_PHASE;
});

const GATE_FILE = /^src\/lib\/.*(?:record-gate|compaction-gate)\.ts$/;

it('every gate module’s exported report is listed', async () => {
    const files = repoRelativeFiles().filter((f) => GATE_FILE.test(f));
    expect(files.length).toBeGreaterThan(0);
    const listed = new Set(Object.values(GATE_REPORTS));
    for (const file of files) {
        const mod = (await import(`../../../${file}`)) as Record<string, unknown>;
        const reports = Object.entries(mod).filter(([name, v]) => /GateReport$/.test(name) && typeof v === 'function');
        expect({ file, reports: reports.length }).toEqual({ file, reports: 1 });
        expect({ file, listed: listed.has(reports[0][1] as never) }).toEqual({ file, listed: true });
    }
    expect(listed.size).toBe(files.length);
});

it('production: one WARN line for each gate the committed records leave unmounted', async () => {
    env.NODE_ENV = 'production';
    delete env.NEXT_PHASE;
    const expected = await recordGateReports('model');
    // The committed records are structural, so production refuses every one.
    expect(expected).toHaveLength(Object.keys(GATE_REPORTS).length);
    const lines: string[] = [];
    const exit = jest.fn();
    await registerNode({ report: (l) => void lines.push(l), exit });
    expect(exit).not.toHaveBeenCalled();
    for (const gate of expected) expect(lines).toContain(`[startup] WARN: ${gate}`);
    for (const phrase of ['deep continuity check', 'stress test', 'gap hunt', 'tie-break', 'rounds summary']) {
        expect(lines.some((l) => l.startsWith('[startup] WARN: ') && l.includes(phrase))).toBe(true);
    }
});

it('development accepts the structural records: no gate line', async () => {
    expect(await recordGateReports('structural')).toEqual([]);
});
