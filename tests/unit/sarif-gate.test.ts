/**
 * The CodeQL gate fails on a high-severity or error-level SECURITY result,
 * passes a clean analysis, ignores quality and suppressed results, and treats
 * an empty results folder as a failure rather than a pass.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const gate = require('../../scripts/sarif-gate.js');

function sarif(results: unknown[], rules: unknown[]) {
    return { version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL', rules: [] }, extensions: [{ name: 'js-queries', rules }] }, results }] };
}

const rules = [
    { id: 'js/sql-injection', properties: { tags: ['security', 'external/cwe/cwe-089'], 'security-severity': '8.8' } },
    { id: 'js/weak-crypto', properties: { tags: ['security'], 'security-severity': '5.0' }, defaultConfiguration: { level: 'warning' } },
    { id: 'js/insecure-thing', properties: { tags: ['security'] }, defaultConfiguration: { level: 'error' } },
    { id: 'js/unused-local-variable', properties: { tags: ['maintainability'] }, defaultConfiguration: { level: 'error' } },
];

const at = (ruleId: string, extra: Record<string, unknown> = {}) => ({
    ruleId,
    locations: [{ physicalLocation: { artifactLocation: { uri: 'src/x.ts' }, region: { startLine: 3 } } }],
    ...extra,
});

function inTempDir(doc: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-sarif-'));
    fs.writeFileSync(path.join(dir, 'javascript.sarif'), JSON.stringify(doc));
    return dir;
}

it('blocks a high-severity security result', () => {
    const findings = gate.findingsIn(sarif([at('js/sql-injection')], rules));
    expect(findings.filter(gate.blocks).map((f: { ruleId: string }) => f.ruleId)).toEqual(['js/sql-injection']);
});

it("blocks an error-level security result (the rule's default level)", () => {
    expect(gate.findingsIn(sarif([at('js/insecure-thing')], rules)).filter(gate.blocks)).toHaveLength(1);
});

it('a medium security result, a quality error and a suppressed or absent result do not block', () => {
    const findings = gate.findingsIn(
        sarif(
            [
                at('js/weak-crypto'),
                at('js/unused-local-variable'),
                at('js/sql-injection', { suppressions: [{ kind: 'inSource' }] }),
                at('js/sql-injection', { baselineState: 'absent' }),
            ],
            rules,
        ),
    );
    expect(findings).toHaveLength(4);
    expect(findings.filter(gate.blocks)).toEqual([]);
});

it('resolves a rule referenced by index into an extension', () => {
    const doc = sarif([{ rule: { index: 0, toolComponent: { index: 0 } } }], rules);
    expect(gate.findingsIn(doc).filter(gate.blocks)).toHaveLength(1);
});

it('evaluate: a folder with a blocking result fails, a clean one passes, an empty one fails', () => {
    expect(gate.evaluate([inTempDir(sarif([at('js/sql-injection')], rules))]).ok).toBe(false);
    expect(gate.evaluate([inTempDir(sarif([at('js/weak-crypto')], rules))]).ok).toBe(true);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-sarif-'));
    expect(gate.evaluate([empty])).toMatchObject({ ok: false, files: [] });
    expect(gate.evaluate([path.join(empty, 'missing')]).ok).toBe(false);
});
