/**
 * Lint planted text with the REPO's eslint.config.mjs, exactly as `npx eslint .`
 * would, at paths that may not exist on disk.
 *
 * A RuleTester suite proves a rule's logic; this proves the config turns the
 * rule on where it must and off only where it should. ESLint runs in a child
 * process because it loads `eslint.config.mjs` with a native dynamic import
 * that Jest's module system does not provide. Only the rule under test runs
 * (`ruleFilter`): every verdict is about that rule, and a fatal parse message
 * is reported separately so a planted file that failed to parse cannot pass an
 * "allows" case by never being read.
 *
 * Lifted from the child-process runner in inflect-compliance's
 * `eslint-rules/__tests__/anthropic-client-single-seam.config.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '../../..');

export type LintResult = { filePath: string; ruleIds: (string | null)[]; fatal: string[] };

export function lintWithRepoConfig(ruleId: string, text: string, filePaths: readonly string[]): LintResult[] {
    const program = `
        const { ESLint } = require('eslint');
        const [ruleId, text, paths] = JSON.parse(process.argv[1]);
        const eslint = new ESLint({ cwd: process.cwd(), ruleFilter: (r) => r.ruleId === ruleId });
        (async () => {
            const out = [];
            for (const filePath of paths) {
                for (const r of await eslint.lintText(text, { filePath })) out.push(r);
            }
            process.stdout.write(JSON.stringify(out.map((r) => ({
                filePath: require('path').relative(process.cwd(), r.filePath),
                ruleIds: r.messages.map((m) => m.ruleId),
                fatal: r.messages.filter((m) => m.fatal).map((m) => m.message),
            }))));
        })().catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(1); });
    `;
    const out = execFileSync(process.execPath, ['-e', program, JSON.stringify([ruleId, text, filePaths])], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(out) as LintResult[];
}
