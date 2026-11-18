'use strict';
/**
 * The CodeQL gate: fail the CodeQL check when the analysis found a security
 * problem that matters.
 *
 * `github/codeql-action/analyze` never fails its job on what it finds, and
 * the SARIF upload to code scanning needs code scanning enabled for the
 * repository. Without this step the CodeQL check was green whatever it found,
 * and with the upload off the findings went nowhere. So the CI job writes the
 * SARIF to a folder, keeps it as an artifact, and runs this over it.
 *
 * A result BLOCKS when it is not suppressed, not a baseline `absent`, and its
 * rule is a SECURITY rule (tagged `security`) that is either
 *   - `security-severity` >= 7.0 (CodeQL's high and critical), or
 *   - level `error` (the result's own level, else the rule's default).
 * Quality queries from the security-and-quality suite are reported in the
 * summary and never block: they are not what this gate is for, and a gate
 * that fails on style gets switched off.
 *
 *   node scripts/sarif-gate.js <folder-or-file>...
 *
 * CommonJS with no dependencies: the CodeQL job runs it with bare `node`, and
 * the Jest suite requires it (tests/unit/sarif-gate.test.ts).
 */
const fs = require('node:fs');
const path = require('node:path');

const HIGH_SECURITY_SEVERITY = 7.0;

/** Every rule a run declares (the driver's and each extension's), by id. */
function rulesOf(run) {
    const rules = new Map();
    const components = [run.tool && run.tool.driver, ...((run.tool && run.tool.extensions) || [])].filter(Boolean);
    for (const c of components) for (const r of c.rules || []) if (r && r.id) rules.set(r.id, r);
    return rules;
}

function ruleFor(result, run, rules) {
    const id = result.ruleId || (result.rule && result.rule.id);
    if (id && rules.has(id)) return rules.get(id);
    // A rule referenced only by index into a tool component.
    const ref = result.rule;
    if (ref && typeof ref.index === 'number') {
        const tc = ref.toolComponent && typeof ref.toolComponent.index === 'number'
            ? ((run.tool && run.tool.extensions) || [])[ref.toolComponent.index]
            : run.tool && run.tool.driver;
        return (tc && tc.rules && tc.rules[ref.index]) || null;
    }
    return null;
}

/** One finding per result, with the facts the gate decides on. */
function findingsIn(sarif) {
    const out = [];
    for (const run of (sarif && sarif.runs) || []) {
        const rules = rulesOf(run);
        for (const result of run.results || []) {
            const rule = ruleFor(result, run, rules);
            const props = (rule && rule.properties) || {};
            const tags = Array.isArray(props.tags) ? props.tags : [];
            const severity = Number.parseFloat(props['security-severity']);
            const level = result.level || (rule && rule.defaultConfiguration && rule.defaultConfiguration.level) || 'warning';
            const loc = result.locations && result.locations[0] && result.locations[0].physicalLocation;
            out.push({
                ruleId: result.ruleId || (rule && rule.id) || '(unknown rule)',
                level,
                securitySeverity: Number.isFinite(severity) ? severity : null,
                security: tags.includes('security'),
                suppressed: Array.isArray(result.suppressions) && result.suppressions.length > 0,
                absent: result.baselineState === 'absent',
                where: loc ? `${loc.artifactLocation && loc.artifactLocation.uri}:${(loc.region && loc.region.startLine) || '?'}` : '(no location)',
            });
        }
    }
    return out;
}

function blocks(f) {
    if (f.suppressed || f.absent || !f.security) return false;
    return (f.securitySeverity !== null && f.securitySeverity >= HIGH_SECURITY_SEVERITY) || f.level === 'error';
}

function sarifFiles(target) {
    if (!fs.existsSync(target)) return [];
    if (fs.statSync(target).isFile()) return [target];
    return fs
        .readdirSync(target, { recursive: true })
        .map((p) => path.join(target, String(p)))
        .filter((p) => /\.sarif$/i.test(p) && fs.statSync(p).isFile());
}

/** The gate's verdict over the given paths: `ok` false when anything blocks or nothing was read. */
function evaluate(targets) {
    const files = targets.flatMap(sarifFiles);
    const findings = files.flatMap((f) => findingsIn(JSON.parse(fs.readFileSync(f, 'utf8'))));
    const blocking = findings.filter(blocks);
    // Zero files read is not a clean analysis: it is a gate that saw nothing.
    return { ok: files.length > 0 && blocking.length === 0, files, findings, blocking };
}

function main(argv) {
    const targets = argv.length > 0 ? argv : ['codeql-results'];
    const { ok, files, findings, blocking } = evaluate(targets);
    if (files.length === 0) {
        process.stderr.write(`CodeQL gate: no .sarif file under ${targets.join(', ')} — the analysis produced nothing to judge.\n`);
        return 1;
    }
    process.stdout.write(`CodeQL gate: ${files.length} SARIF file(s), ${findings.length} result(s), ${blocking.length} blocking.\n`);
    for (const f of blocking) {
        process.stdout.write(`  BLOCKING ${f.ruleId} [${f.level}${f.securitySeverity !== null ? `, severity ${f.securitySeverity}` : ''}] ${f.where}\n`);
    }
    return ok ? 0 : 1;
}

module.exports = { HIGH_SECURITY_SEVERITY, findingsIn, blocks, evaluate, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
