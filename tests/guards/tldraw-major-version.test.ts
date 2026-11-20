/**
 * tldraw stays on major version 3 (decision D1, roadmap 3.1).
 *
 * tldraw's 3.x licence allows commercial use with its watermark shown, and
 * that is the owner's licence position; a later major comes under other
 * terms, so moving to it is an owner decision, never a dependency bump. This
 * guard fails when `package.json` asks for, or `package-lock.json` resolves,
 * `tldraw` or any `@tldraw/*` package off major 3 — a range that admits 4
 * (`>=3`, `*`, `latest`, `^4`), an override (by name, with a version selector,
 * or on "."), an npm alias installing tldraw under another name, a nested or
 * aliased copy at another major in the lockfile.
 *
 * The checker is pure and proved against made-up manifests at the bottom, so
 * it cannot pass by reading nothing; and the real tree must hold at least the
 * packages the canvas imports.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT } from '../helpers/repo-files';

const isTldrawPackage = (name: string) => name === 'tldraw' || name.startsWith('@tldraw/');

/** The package an npm alias (`npm:<name>@<range>`) installs, or null for a plain range. */
function aliasTarget(spec: string): { name: string; range: string } | null {
    const m = /^npm:((?:@[^/@\s]+\/)?[^/@\s]+)(?:@(.*))?$/.exec(spec.trim());
    return m ? { name: m[1], range: m[2] ?? '' } : null;
}

/** An override key names its package, optionally with a version selector (`tldraw@^3`). */
function overrideKeyPackage(key: string): string {
    const at = key.indexOf('@', key.startsWith('@') ? 1 : 0);
    return at === -1 ? key : key.slice(0, at);
}

/** A dependency spec that can only ever resolve a 3.x release: `3.a.b`, `^3.a.b`, `~3.a.b`. */
export function specPinsMajor3(spec: string): boolean {
    return /^[\^~]?3\.\d+\.\d+$/.test(spec.trim());
}

export function manifestProblems(pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; overrides?: Record<string, unknown> }): string[] {
    const problems: string[] = [];
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
        for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
            if (isTldrawPackage(name) && !specPinsMajor3(spec)) problems.push(`package.json ${field}.${name} is "${spec}", not a 3.x range`);
            // An alias installs tldraw under another name (`"canvas": "npm:tldraw@4"`).
            const alias = aliasTarget(spec);
            if (alias && isTldrawPackage(alias.name) && !specPinsMajor3(alias.range)) problems.push(`package.json ${field}.${name} aliases ${alias.name}@${alias.range || '(any)'}, not a 3.x range`);
        }
    }
    // An override can move a package's version wherever it appears in the tree.
    const walk = (node: unknown, trail: string): void => {
        if (typeof node !== 'object' || node === null) return;
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
            // A key may carry a version selector (`tldraw@3.15.6`), and an object
            // value sets the package itself under "." (`"tldraw": { ".": "4.0.0" }`).
            const target = overrideKeyPackage(key === '.' ? (trail.split(' > ').slice(-2, -1)[0] ?? '') : key);
            if (typeof value === 'string') {
                if (isTldrawPackage(target) && !specPinsMajor3(value) && !value.startsWith('$')) problems.push(`package.json overrides ${trail}${key} is "${value}", not a 3.x range`);
                const alias = aliasTarget(value);
                if (alias && isTldrawPackage(alias.name) && !specPinsMajor3(alias.range)) problems.push(`package.json overrides ${trail}${key} aliases ${alias.name}@${alias.range || '(any)'}, not a 3.x range`);
                if (isTldrawPackage(target) && value.startsWith('$')) {
                    const referenced = pkg.dependencies?.[value.slice(1)] ?? pkg.devDependencies?.[value.slice(1)];
                    if (referenced === undefined || !specPinsMajor3(referenced)) problems.push(`package.json overrides ${trail}${key} is "${value}", which is not a 3.x range`);
                }
            }
            walk(value, `${trail}${key} > `);
        }
    };
    walk(pkg.overrides, '');
    return problems;
}

export function lockfileProblems(lock: { packages?: Record<string, { version?: string; name?: string }> }): { problems: string[]; found: string[] } {
    const problems: string[] = [];
    const found: string[] = [];
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
        const at = key.lastIndexOf('node_modules/');
        if (at === -1) continue;
        // An aliased install is keyed by its alias and names the real package in `name`.
        const name = entry.name ?? key.slice(at + 'node_modules/'.length);
        if (!isTldrawPackage(name)) continue;
        found.push(name);
        if (!/^3\.\d+\.\d+$/.test(entry.version ?? '')) problems.push(`package-lock.json ${key} resolves ${entry.version ?? '(no version)'}, not 3.x`);
    }
    return { problems, found };
}

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));

it('package.json asks for tldraw 3.x only', () => {
    expect(pkg.dependencies?.tldraw).toBeDefined();
    expect(manifestProblems(pkg)).toEqual([]);
});

it('package-lock.json resolves tldraw and every @tldraw/* package at 3.x', () => {
    const { problems, found } = lockfileProblems(lock);
    // Zero packages is never compliance: the canvas imports these.
    expect(found).toEqual(expect.arrayContaining(['tldraw', '@tldraw/editor', '@tldraw/assets']));
    expect(problems).toEqual([]);
});

describe('the checker catches what it should', () => {
    it('refuses a range that admits another major', () => {
        for (const spec of ['^4.0.0', '>=3.0.0', '*', 'latest', '3', '3.x', '^3', 'git+https://example.invalid/tldraw']) {
            expect(manifestProblems({ dependencies: { tldraw: spec } })).toHaveLength(1);
        }
        expect(manifestProblems({ dependencies: { tldraw: '^3.15.6', '@tldraw/assets': '~3.15.6', other: '^9.0.0' } })).toEqual([]);
    });

    it('refuses an override, however deep, and a dev or peer dependency', () => {
        expect(manifestProblems({ overrides: { tldraw: '4.0.0' } })).toHaveLength(1);
        expect(manifestProblems({ overrides: { something: { '@tldraw/editor': '^4.1.0' } } })).toHaveLength(1);
        expect(manifestProblems({ devDependencies: { '@tldraw/tlschema': '^5.0.0' } })).toHaveLength(1);
        expect(manifestProblems({ overrides: { tldraw: { '@tiptap/core': '^3.34.0' } } })).toEqual([]);
    });

    it('refuses tldraw installed under an alias, an override with a version selector, and a "." override', () => {
        expect(manifestProblems({ dependencies: { canvas: 'npm:tldraw@^4.0.0' } })).toHaveLength(1);
        expect(manifestProblems({ dependencies: { canvas: 'npm:@tldraw/editor' } })).toHaveLength(1);
        expect(manifestProblems({ dependencies: { canvas: 'npm:tldraw@^3.15.6' } })).toEqual([]);
        expect(manifestProblems({ overrides: { 'tldraw@3.15.6': '4.0.0' } })).toHaveLength(1);
        expect(manifestProblems({ overrides: { '@tldraw/editor@^3': '^4.1.0' } })).toHaveLength(1);
        expect(manifestProblems({ overrides: { tldraw: { '.': '4.0.0' } } })).toHaveLength(1);
        expect(manifestProblems({ overrides: { 'tldraw@^3': { '.': '4.0.0' } } })).toHaveLength(1);
        expect(manifestProblems({ overrides: { something: 'npm:tldraw@4.0.0' } })).toHaveLength(1);
        expect(manifestProblems({ dependencies: { tldraw: '^4.0.0' }, overrides: { tldraw: '$tldraw' } })).toHaveLength(2);
        expect(manifestProblems({ dependencies: { tldraw: '^3.15.6' }, overrides: { tldraw: '$tldraw' } })).toEqual([]);
    });

    it('refuses a resolved or nested copy off major 3', () => {
        expect(lockfileProblems({ packages: { 'node_modules/tldraw': { version: '4.0.1' } } }).problems).toHaveLength(1);
        expect(lockfileProblems({ packages: { 'node_modules/x/node_modules/@tldraw/editor': { version: '5.0.0' } } }).problems).toHaveLength(1);
        expect(lockfileProblems({ packages: { 'node_modules/canvas': { name: 'tldraw', version: '4.0.1' } } }).problems).toHaveLength(1);
        expect(lockfileProblems({ packages: { 'node_modules/tldraw': { version: '3.15.6' }, 'node_modules/tldrawish': { version: '9.0.0' } } })).toEqual({
            problems: [],
            found: ['tldraw'],
        });
    });
});
