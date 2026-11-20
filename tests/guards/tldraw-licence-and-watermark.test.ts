/**
 * No tldraw licence key is read or set, and nothing hides or restyles the
 * watermark (decision D1: tldraw 3.x is used commercially WITH its watermark,
 * which is what its licence allows without a key).
 *
 * A source scan over every text file git lists outside the documentation and
 * the tests: the prop or option a key would travel in (`licenseKey`), an
 * environment variable meant to carry one (`TLDRAW_LICENSE…`), and the
 * watermark's class (`tl-watermark…`), which only a stylesheet or a script
 * hiding it would name. The checker is proved against made-up sources.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BINARY_EXTENSIONS } from '../helpers/binary-extensions';
import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

const FORBIDDEN: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
    { rule: 'a tldraw licence key prop or option', pattern: /\blicen[cs]eKey\b/i },
    { rule: 'a tldraw licence environment variable', pattern: /\bTLDRAW_LICEN[CS]E/i },
    { rule: 'the tldraw watermark class', pattern: /\btl-watermark/i },
];

export function licenceProblems(files: Readonly<Record<string, string>>): string[] {
    const problems: string[] = [];
    for (const [file, text] of Object.entries(files)) {
        for (const { rule, pattern } of FORBIDDEN) if (pattern.test(text)) problems.push(`${file}: ${rule}`);
    }
    return problems;
}

/** Documentation may discuss the decision, and tests (this one) must name what they forbid. */
const inScope = (f: string) => !f.startsWith('docs/') && !f.startsWith('tests/') && !f.endsWith('.md') && !BINARY_EXTENSIONS.has(path.extname(f).toLowerCase());

const files = repoRelativeFiles().filter(inScope);
const sources = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')]));

it('scans the tree, including the canvas that mounts tldraw', () => {
    expect(files).toEqual(expect.arrayContaining(['src/components/canvas/StoryMapCanvas.tsx', 'src/env.ts', '.env.example', 'next.config.mjs']));
});

it('no licence key is read or set, and nothing names the watermark', () => {
    expect(licenceProblems(sources)).toEqual([]);
});

describe('the checker catches what it should', () => {
    it('finds a key passed to the editor, a key variable and a watermark override', () => {
        expect(licenceProblems({ 'a.tsx': '<Tldraw licenseKey={env.KEY} />' })).toEqual(['a.tsx: a tldraw licence key prop or option']);
        expect(licenceProblems({ '.env.example': 'TLDRAW_LICENSE_KEY=' })).toEqual(['.env.example: a tldraw licence environment variable']);
        expect(licenceProblems({ 'g.css': '.tl-watermark_SEE-LICENSE { display: none }' })).toEqual(['g.css: the tldraw watermark class']);
        expect(licenceProblems({ 'ok.tsx': '<Tldraw shapeUtils={UTILS} />' })).toEqual([]);
    });
});
