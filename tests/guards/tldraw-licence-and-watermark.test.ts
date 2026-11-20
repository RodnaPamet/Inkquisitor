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
 *
 * Phase 3.H (item 7) widened it to every way a stylesheet or a script reaches
 * the watermark WITHOUT its class name. tldraw 3.15 renders it as a
 * `div.tl-watermark_SEE-LICENSE[data-debug][data-mobile]` holding a button
 * that links to tldraw (`@tldraw/editor`'s `Watermark.js`), so each of these
 * is refused outside docs and tests: the class's own suffix (`SEE-LICENSE`),
 * a selector on its two data attributes, a substring selector on a class
 * (`[class*=…]`, `^=`, `$=`) aimed at a watermark, a licence or tldraw's own
 * `tl-` classes, a selector on a link to tldraw, the key under any spelling
 * (`license_key`, `licence-key`), and, in a stylesheet, the word
 * "watermark" at all (`display: none`, `opacity: 0`, `visibility: hidden` on
 * it all need to name it, by one of these). In a browser, the E2E map spec
 * sees the watermark drawn and visible.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BINARY_EXTENSIONS } from '../helpers/binary-extensions';
import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

const FORBIDDEN: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
    { rule: 'a tldraw licence key prop or option', pattern: /\blicen[cs]e[_-]?key\b/i },
    { rule: 'a tldraw licence environment variable', pattern: /\bTLDRAW_LICEN[CS]E/i },
    { rule: 'the tldraw watermark class', pattern: /\btl-watermark/i },
    { rule: 'the tldraw watermark class suffix', pattern: /SEE-LICEN[CS]E/i },
    { rule: 'a selector on the watermark data attributes', pattern: /\[\s*data-(?:debug|mobile|unlicensed)\b/i },
    { rule: 'a class substring selector aimed at the watermark or tldraw', pattern: /\[\s*class\s*[*^$~|]=\s*["']?[^"'\]]{0,40}(?:water|licen|tl-)/i },
    { rule: 'a selector on a link to tldraw', pattern: /\[\s*href\s*[*^$~|]?=\s*["']?[^"'\]]{0,80}tldraw/i },
];

/** In a stylesheet, the watermark is not to be named at all. */
const STYLESHEET = /\.(?:css|scss|sass|less)$/i;
const IN_A_STYLESHEET: ReadonlyArray<{ rule: string; pattern: RegExp }> = [{ rule: 'a stylesheet naming the watermark', pattern: /watermark/i }];

export function licenceProblems(files: Readonly<Record<string, string>>): string[] {
    const problems: string[] = [];
    for (const [file, text] of Object.entries(files)) {
        const rules = STYLESHEET.test(file) ? [...FORBIDDEN, ...IN_A_STYLESHEET] : FORBIDDEN;
        for (const { rule, pattern } of rules) if (pattern.test(text)) problems.push(`${file}: ${rule}`);
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
        expect(licenceProblems({ 'g.css': '.tl-watermark_SEE-LICENSE { display: none }' })).toEqual(
            expect.arrayContaining(['g.css: the tldraw watermark class', 'g.css: the tldraw watermark class suffix', 'g.css: a stylesheet naming the watermark']),
        );
        expect(licenceProblems({ 'ok.tsx': '<Tldraw shapeUtils={UTILS} />' })).toEqual([]);
    });

    it('finds the watermark hidden or restyled WITHOUT its full class name (3.H)', () => {
        const cases: Array<[string, string, string]> = [
            ['a.css', '[class*="watermark"] { display: none }', 'a class substring selector aimed at the watermark or tldraw'],
            ['b.css', ".tl-container [class^='tl-'] > button { opacity: 0 }", 'a class substring selector aimed at the watermark or tldraw'],
            ['c.css', 'div[data-debug] { visibility: hidden }', 'a selector on the watermark data attributes'],
            ['d.css', "[data-mobile='true'] > button { display:none }", 'a selector on the watermark data attributes'],
            ['e.css', 'a[href*="tldraw.dev"] { display: none }', 'a selector on a link to tldraw'],
            ['f.tsx', "document.querySelector('.SEE-LICENSE')?.remove()", 'the tldraw watermark class suffix'],
            ['g.tsx', "<Tldraw options={{ license_key: k }} />", 'a tldraw licence key prop or option'],
            ['h.ts', "const LICENCE-KEY = 1", 'a tldraw licence key prop or option'],
            ['i.scss', '.canvas .watermark { opacity: .01 }', 'a stylesheet naming the watermark'],
        ];
        for (const [file, text, rule] of cases) expect(licenceProblems({ [file]: text })).toContain(`${file}: ${rule}`);
        // What the canvas legitimately writes is not caught.
        expect(licenceProblems({ 'ok.css': '[data-story-canvas="true"] { height: 100% } .tl-container { isolation: isolate }' })).toEqual([]);
        expect(licenceProblems({ 'ok.ts': "export const TLDRAW_WATERMARK_TRACK_URL = 'https://cdn.tldraw.com/3.15.6/watermarks/watermark-track.svg';" })).toEqual([]);
    });
});

describe('the watermark is tldraw’s to draw', () => {
    it('the installed tldraw still draws it with the class and attributes this guard knows (a release that renames them is re-read here)', () => {
        const watermark = fs.readFileSync(path.join(REPO_ROOT, 'node_modules/@tldraw/editor/dist-cjs/lib/license/Watermark.js'), 'utf8');
        const manager = fs.readFileSync(path.join(REPO_ROOT, 'node_modules/@tldraw/editor/dist-cjs/lib/license/LicenseManager.js'), 'utf8');
        expect(manager).toContain('tl-watermark_SEE-LICENSE');
        expect(watermark).toContain('"data-debug"');
        expect(watermark).toContain('"data-mobile"');
    });
});
