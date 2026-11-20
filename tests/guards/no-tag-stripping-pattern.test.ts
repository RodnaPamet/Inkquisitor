/**
 * No tag-stripping pattern in application code.
 *
 * Markup becomes text through a parser — `HtmlTextReader`
 * (`src/lib/search/plain-text.ts`), the sanitiser behind `plainBlock`, or
 * `valueAsText` (`src/lib/enrichment/validate.ts`) — never through a regular
 * expression that deletes "a `<`, anything, a `>`" (`/<[^>]*>/g`, `/<.*?>/g`).
 * Such a pattern leaves entities undecoded and an unclosed `<script` in
 * place, and it is the shape CodeQL's incomplete multi-character
 * sanitisation query reports at high severity, which the CodeQL check's gate
 * (`scripts/sarif-gate.js`) blocks on. Phase 3.3's evaluation grader carried
 * one; this guard keeps the next out.
 *
 * Specific tags (`/<br\s*\/?>/`, `/<li[^>]*>/`) are line breaks, not
 * sanitisation, and are not what this guards. The population is git's.
 */
import * as fs from 'node:fs';
import ts from 'typescript';
import { repoFiles, repoRelative } from '../helpers/repo-files';

const SOURCES = [...repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }), ...repoFiles({ under: 'scripts', extensions: ['.ts', '.mjs', '.js'] })];

/** A regex literal's body that matches any tag at all: `<`, then anything up to `>`. */
const ANY_TAG_BODIES: readonly RegExp[] = [/^<\[\^>\][*+]\??>$/, /^<\.[*+]\??>$/, /^<\[\\s\\S\][*+]\??>$/];

function anyTagPatternsIn(source: string, fileName = 'x.ts'): string[] {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out: string[] = [];
    const visit = (node: ts.Node) => {
        if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
            const text = node.getText(sf);
            const body = text.slice(1, text.lastIndexOf('/'));
            if (ANY_TAG_BODIES.some((p) => p.test(body))) out.push(text);
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

describe('no tag-stripping pattern', () => {
    it('recognises the shapes it refuses, and leaves specific tags alone', () => {
        expect(anyTagPatternsIn("const a = s.replace(/<[^>]*>/g, ' ');")).toEqual(['/<[^>]*>/g']);
        expect(anyTagPatternsIn("const a = s.replace(/<[^>]+>/g, '');")).toEqual(['/<[^>]+>/g']);
        expect(anyTagPatternsIn("const a = s.replace(/<.*?>/g, '');")).toEqual(['/<.*?>/g']);
        expect(anyTagPatternsIn("const a = s.replace(/<br\\s*\\/?>/gi, '\\n').replace(/<li[^>]*>/gi, '- ');")).toEqual([]);
    });

    it('no source under src/ or scripts/ strips tags with a regular expression', () => {
        const offenders = SOURCES.flatMap((file) => anyTagPatternsIn(fs.readFileSync(file, 'utf8'), file).map((p) => `${repoRelative(file)}: ${p}`));
        expect(offenders).toEqual([]);
    });
});
