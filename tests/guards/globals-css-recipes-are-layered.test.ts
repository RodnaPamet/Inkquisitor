/**
 * Every class-keyed rule in src/app/globals.css sits inside a `@layer`.
 *
 * Rule followed from inflect-compliance's guard of the same name (see
 * docs/carve-manifest.md), with a smaller parser. Tailwind v4 emits every
 * utility inside `@layer utilities`, and an UNLAYERED rule beats a layered
 * one at equal specificity regardless of source order — so an unlayered
 * `.foo { padding: … }` silently swallows every `p-*` utility put on a
 * `.foo` element. inflect measured that on `.glass-card` (#3119), where every
 * `<Card>` lost its padding and background utilities to the recipe.
 *
 * The one exemption is written down here and in the stylesheet: the 44px
 * `.input` touch floor under `@media (pointer: coarse)`, a minimum that must
 * NOT lose to a utility.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const CSS = path.resolve(__dirname, '../../src/app/globals.css');

interface Rule {
    selector: string;
    ancestors: string[];
}

/** Every style rule with the at-rules that enclose it, outermost first. */
export function rulesOf(source: string): Rule[] {
    const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules: Rule[] = [];
    const stack: string[] = [];
    let buf = '';
    for (const ch of css) {
        if (ch === '{') {
            const head = buf.trim();
            buf = '';
            if (!head.startsWith('@')) rules.push({ selector: head, ancestors: [...stack] });
            stack.push(head);
        } else if (ch === '}') {
            stack.pop();
            buf = '';
        } else if (ch === ';' && stack.length === 0) {
            buf = ''; // a top-level statement (`@import …;`)
        } else {
            buf += ch;
        }
    }
    return rules;
}

const EXEMPT = [{ selector: '.input', ancestor: '@media (pointer: coarse)' }];

function unlayeredClassRules(source: string): string[] {
    return rulesOf(source)
        // Declarations nested inside a rule (`&::-webkit-scrollbar`) belong to it.
        .filter((r) => !r.ancestors.some((a) => !a.startsWith('@')))
        .filter((r) => /\.[a-zA-Z]/.test(r.selector))
        .filter((r) => !r.ancestors.some((a) => a.startsWith('@layer')))
        .filter((r) => !EXEMPT.some((e) => r.selector === e.selector && r.ancestors.includes(e.ancestor)))
        .map((r) => `${[...r.ancestors, r.selector].join(' > ')}`);
}

describe('globals.css recipes are layered', () => {
    it('the parser tells a layered rule from an unlayered one', () => {
        const sample = `
            @import "x";
            body { color: red; }
            @layer components { .a { color: red; } @media print { .b { x: y; } } }
            .c { color: red; }
            @media (pointer: coarse) { .input { min-height: 44px; } .d { x: y; } }
        `;
        expect(unlayeredClassRules(sample)).toEqual(['.c', '@media (pointer: coarse) > .d']);
    });

    it('every class-keyed rule in globals.css is inside a @layer (one written exemption)', () => {
        const source = fs.readFileSync(CSS, 'utf8');
        expect(rulesOf(source).filter((r) => /\.[a-zA-Z]/.test(r.selector)).length).toBeGreaterThan(10);
        expect(unlayeredClassRules(source)).toEqual([]);
    });
});
