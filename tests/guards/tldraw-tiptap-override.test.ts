/**
 * The TipTap override for tldraw (decision D20) holds, and moves together
 * with the tldraw major-version guard.
 *
 * tldraw 3.x (D1) declares TipTap 2, and GHSA-cp6q-959q-f8rh (moderate,
 * `mergeAttributes` and own `__proto__` keys) has no TipTap 2 fix, so
 * `package.json` overrides tldraw's and `@tldraw/editor`'s TipTap
 * dependencies onto the root's 3.x line. This guard fails when:
 *
 *   - any `@tiptap/*` package in the lockfile resolves off major 3 (a TipTap 2
 *     copy is the advisory back);
 *   - a TipTap dependency the installed tldraw or `@tldraw/editor` declares is
 *     not overridden, or is overridden to anything but a 3.x range or a
 *     reference to a root dependency on a 3.x range (a tldraw patch release
 *     that adds a TipTap package lands here);
 *   - the installed tldraw stops declaring TipTap 2: the override's reason is
 *     gone, and it is removed with the tldraw move, never left behind.
 *
 * The sticky-note E2E (`tests/e2e/story-map.spec.ts`) is the override's proof
 * that tldraw's rich text works on TipTap 3, and
 * `tests/rendered/tldraw-rich-text-extensions.test.tsx` the extension list it
 * needs. The checker is pure and proved against made-up manifests below.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT } from '../helpers/repo-files';

const OVERRIDDEN = ['tldraw', '@tldraw/editor'] as const;

type Manifest = { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; overrides?: Record<string, unknown> };

const isMajor3Range = (spec: string) => /^[\^~]?3\.\d+\.\d+$/.test(spec.trim());

export function overrideProblems(root: Manifest, declared: Readonly<Record<string, Readonly<Record<string, string>>>>): string[] {
    const problems: string[] = [];
    for (const pkg of OVERRIDDEN) {
        const wanted = Object.keys(declared[pkg] ?? {}).filter((d) => d.startsWith('@tiptap/'));
        const override = root.overrides?.[pkg];
        if (wanted.length > 0 && (typeof override !== 'object' || override === null)) {
            problems.push(`package.json overrides.${pkg} is missing`);
            continue;
        }
        for (const dep of wanted) {
            const spec = (override as Record<string, unknown>)[dep];
            if (typeof spec !== 'string') {
                problems.push(`overrides.${pkg}.${dep} is missing`);
                continue;
            }
            const resolved = spec.startsWith('$') ? root.dependencies?.[spec.slice(1)] : spec;
            if (spec.startsWith('$') && spec.slice(1) !== dep) problems.push(`overrides.${pkg}.${dep} refers to another package (${spec})`);
            if (resolved === undefined || !isMajor3Range(resolved)) problems.push(`overrides.${pkg}.${dep} is "${spec}", not TipTap 3`);
        }
    }
    return problems;
}

export function lockedTiptapProblems(lock: { packages?: Record<string, { version?: string; name?: string }> }): { problems: string[]; found: number } {
    const problems: string[] = [];
    let found = 0;
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
        const at = key.lastIndexOf('node_modules/');
        if (at === -1) continue;
        const name = entry.name ?? key.slice(at + 'node_modules/'.length);
        if (!name.startsWith('@tiptap/')) continue;
        found += 1;
        if (!/^3\.\d+\.\d+$/.test(entry.version ?? '')) problems.push(`${key} resolves ${entry.version ?? '(no version)'}, not TipTap 3`);
    }
    return { problems, found };
}

const root: Manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));
const installed = Object.fromEntries(
    OVERRIDDEN.map((p) => {
        const m: Manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'node_modules', p, 'package.json'), 'utf8'));
        return [p, { ...m.peerDependencies, ...m.dependencies }];
    }),
);

it('the installed tldraw still declares TipTap 2: the override’s reason holds', () => {
    const tiptap = Object.entries(installed.tldraw).filter(([d]) => d.startsWith('@tiptap/'));
    expect(tiptap.length).toBeGreaterThan(0);
    for (const [, spec] of tiptap) expect(spec).toMatch(/^\^2\./);
});

it('every TipTap dependency tldraw and @tldraw/editor declare is overridden onto TipTap 3', () => {
    expect(overrideProblems(root, installed)).toEqual([]);
});

it('the lockfile holds no TipTap off major 3', () => {
    const { problems, found } = lockedTiptapProblems(lock);
    expect(found).toBeGreaterThan(5);
    expect(problems).toEqual([]);
});

describe('the checker catches what it should', () => {
    const declared = { tldraw: { '@tiptap/core': '^2.9.1', '@tiptap/pm': '^2.9.1', other: '^1.0.0' }, '@tldraw/editor': { '@tiptap/core': '^2.9.1' } };
    it('refuses a missing, partial or TipTap 2 override', () => {
        expect(overrideProblems({ dependencies: {} }, declared)).toHaveLength(2);
        expect(overrideProblems({ overrides: { tldraw: { '@tiptap/core': '^3.1.0' }, '@tldraw/editor': { '@tiptap/core': '^3.1.0' } } }, declared)).toEqual([
            'overrides.tldraw.@tiptap/pm is missing',
        ]);
        expect(
            overrideProblems({ dependencies: { '@tiptap/pm': '^2.27.0' }, overrides: { tldraw: { '@tiptap/core': '^3.1.0', '@tiptap/pm': '$@tiptap/pm' }, '@tldraw/editor': { '@tiptap/core': '^3.1.0' } } }, declared),
        ).toHaveLength(1);
    });
    it('accepts a 3.x range or a reference to a root dependency on one', () => {
        expect(
            overrideProblems({ dependencies: { '@tiptap/pm': '^3.33.1' }, overrides: { tldraw: { '@tiptap/core': '^3.34.0', '@tiptap/pm': '$@tiptap/pm' }, '@tldraw/editor': { '@tiptap/core': '~3.34.0' } } }, declared),
        ).toEqual([]);
    });
    it('refuses a locked TipTap 2 copy, nested or aliased', () => {
        expect(lockedTiptapProblems({ packages: { 'node_modules/tldraw/node_modules/@tiptap/core': { version: '2.27.1' } } }).problems).toHaveLength(1);
        expect(lockedTiptapProblems({ packages: { 'node_modules/tt': { name: '@tiptap/pm', version: '2.0.0' } } }).problems).toHaveLength(1);
        expect(lockedTiptapProblems({ packages: { 'node_modules/@tiptap/core': { version: '3.34.0' } } })).toEqual({ problems: [], found: 1 });
    });
});
