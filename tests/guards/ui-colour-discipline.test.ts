/**
 * The UI paints only through the design tokens, and overlays come only from
 * the shared primitives.
 *
 * Rules followed from inflect-compliance's colour and overlay guards
 * (`no-raw-palette-greys`, `raw-color-eradication`, `modal-overlay-guard`;
 * see docs/carve-manifest.md), rewritten for this tree rather than copied:
 * those read inflect's own paths and carry its baselines.
 *
 *   1. No hex colour literal in component code. A colour belongs in
 *      src/styles/tokens.css, where both themes define it; a literal is
 *      one fixed colour in a two-theme product. The package's icon set is
 *      exempt: brand logos are drawn in their owners' colours.
 *   2. No Tailwind palette-scale utility (`bg-slate-800`, `text-stone-600`,
 *      …). Same reason, spelled as a class. `white` / `black` washes (gloss
 *      highlights, overlays) are not a scale and are allowed.
 *   3. No hand-rolled overlay outside the primitives: a `fixed inset-0`
 *      painted black, or a raw `role="dialog"`, belongs to `<Modal>` or
 *      `<Sheet>`, which bring the focus trap, Escape and portal with them.
 *
 * Only STRING content is scanned — literals, template text, JSX text and
 * attribute values — found by walking the TypeScript AST, so a comment that
 * describes a banned pattern is never reported, and a class built in a
 * template string still is. The population is git's
 * (tests/helpers/repo-files.ts).
 */
import * as fs from 'node:fs';
import * as ts from 'typescript';
import { repoFiles, repoRelative } from '../helpers/repo-files';

const UI_ROOTS = ['src/app', 'src/components', 'packages/ui/src'];
const ICONS_DIR = 'packages/ui/src/components/ui/icons/';
const PRIMITIVE_ROOTS = ['src/components/ui/', 'packages/ui/src/'];

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/;
const PALETTE =
    /(?:^|[\s:"'`[(])!?(?:bg|text|border|ring|from|to|via|fill|stroke|outline|divide|placeholder|shadow|decoration|caret|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
const OVERLAY = /\bfixed\b[^"'`]*\binset-0\b[^"'`]*\bbg-black\b|\bbg-black\b[^"'`]*\bfixed\b[^"'`]*\binset-0\b/;

/** Every piece of string content in a source file. */
export function stringsOf(fileName: string, source: string): string[] {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
        fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out: string[] = [];
    const visit = (node: ts.Node) => {
        if (
            ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node)
        ) {
            out.push(node.text);
        } else if (ts.isJsxText(node)) {
            out.push(node.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

/** `role="dialog"` written as a JSX attribute. */
function hasRawDialogRole(fileName: string, source: string): boolean {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let found = false;
    const visit = (node: ts.Node) => {
        if (
            ts.isJsxAttribute(node) &&
            node.name.getText(sf) === 'role' &&
            node.initializer &&
            ts.isStringLiteral(node.initializer) &&
            node.initializer.text === 'dialog'
        ) {
            found = true;
        }
        if (!found) ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
}

const FILES = UI_ROOTS.flatMap((under) => repoFiles({ under, extensions: ['.ts', '.tsx'] }))
    .map((abs) => ({ rel: repoRelative(abs), src: fs.readFileSync(abs, 'utf8') }))
    .filter(({ rel }) => !/\.test\.tsx?$/.test(rel) && !rel.includes('/__tests__/'));

function offenders(test: (s: string) => boolean, scope: (rel: string) => boolean): string[] {
    return FILES.filter(({ rel }) => scope(rel))
        .filter(({ rel, src }) => stringsOf(rel, src).some(test))
        .map(({ rel }) => rel);
}

describe('UI colour discipline', () => {
    it('scans a real population', () => {
        expect(FILES.length).toBeGreaterThan(50);
        expect(FILES.some(({ rel }) => rel === 'src/components/layout/AppShell.tsx')).toBe(true);
        expect(FILES.some(({ rel }) => rel.startsWith('packages/ui/src/'))).toBe(true);
    });

    it('the detectors catch what they are meant to, in strings only', () => {
        expect(stringsOf('a.tsx', 'const a = "#1a2b3c"; // #ffffff\n<div className="bg-slate-800" />')).toEqual([
            '#1a2b3c',
            'bg-slate-800',
        ]);
        expect(stringsOf('a.ts', 'const c = `p-2 ${x} text-stone-600`;')).toEqual(['p-2 ', ' text-stone-600']);
        expect(HEX.test('color: #FFCD11')).toBe(true);
        expect(HEX.test('issue #308')).toBe(true);
        expect(HEX.test('#section-anchor')).toBe(false);
        expect(PALETTE.test('px-2 text-stone-600')).toBe(true);
        expect(PALETTE.test('hover:bg-red-500/50')).toBe(true);
        expect(PALETTE.test('bg-bg-default text-content-muted')).toBe(false);
        expect(PALETTE.test('bg-white/10 text-black')).toBe(false);
        expect(OVERLAY.test('fixed inset-0 z-50 bg-black/60')).toBe(true);
        expect(OVERLAY.test('fixed inset-0 bg-bg-overlay')).toBe(false);
        expect(hasRawDialogRole('a.tsx', '<div role="dialog" />')).toBe(true);
        expect(hasRawDialogRole('a.tsx', '<div role="region" />')).toBe(false);
    });

    it('no hex colour literal in component code (icons exempt)', () => {
        expect(offenders((s) => HEX.test(s), (rel) => !rel.startsWith(ICONS_DIR))).toEqual([]);
    });

    it('no Tailwind palette-scale utility anywhere in the UI', () => {
        expect(offenders((s) => PALETTE.test(s), () => true)).toEqual([]);
    });

    it('no hand-rolled black overlay outside the shared primitives', () => {
        expect(
            offenders((s) => OVERLAY.test(s), (rel) => !PRIMITIVE_ROOTS.some((root) => rel.startsWith(root))),
        ).toEqual([]);
    });

    it('no raw role="dialog" outside the shared primitives', () => {
        const bad = FILES.filter(({ rel }) => !PRIMITIVE_ROOTS.some((root) => rel.startsWith(root)))
            .filter(({ rel, src }) => rel.endsWith('.tsx') && hasRawDialogRole(rel, src))
            .map(({ rel }) => rel);
        expect(bad).toEqual([]);
    });
});
