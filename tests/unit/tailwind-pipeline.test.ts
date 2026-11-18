/**
 * Tailwind 4 actually generates the page's utilities.
 *
 * The home page's class strings prove nothing about styling: Jest maps
 * stylesheets to an empty module, and `next build` still succeeds when
 * `@import "tailwindcss"` or the PostCSS plugin is gone; it just emits no
 * utility CSS. This test runs src/app/globals.css through the plugins the
 * real postcss.config.mjs declares, scanning src/ as the content source, and
 * requires the rules the home page's heading uses. Deleting the import, the
 * plugin, or the heading's classes fails it. No network.
 *
 * PostCSS runs in a child Node process: the config is ESM and Tailwind's
 * dependency graph is too, neither of which Jest's CommonJS runtime loads.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

// Imports postcss.config.mjs as Next would and applies each plugin with its
// declared options. `base` limits Tailwind's content detection to src/, so a
// class named only in a test file cannot satisfy this test.
const RUNNER = `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import postcss from 'postcss';
const root = process.cwd();
const { default: config } = await import(pathToFileURL(path.join(root, 'postcss.config.mjs')).href);
const names = Object.keys(config.plugins ?? {});
const plugins = [];
for (const name of names) {
    const { default: plugin } = await import(name);
    const opts = { ...config.plugins[name] };
    if (name === '@tailwindcss/postcss') opts.base = path.join(root, 'src');
    plugins.push(plugin(opts));
}
const from = path.join(root, 'src/app/globals.css');
const { css } = await postcss(plugins).process(fs.readFileSync(from, 'utf8'), { from });
process.stdout.write(JSON.stringify({ names, css }));
`;

describe('Tailwind pipeline', () => {
    let result: { names: string[]; css: string };

    beforeAll(() => {
        const out = execFileSync(process.execPath, ['--input-type=module', '-e', RUNNER], {
            cwd: ROOT,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
        });
        result = JSON.parse(out) as { names: string[]; css: string };
    }, 60_000);

    it('postcss.config.mjs declares the Tailwind plugin', () => {
        expect(result.names).toEqual(['@tailwindcss/postcss']);
    });

    it("generates the home page heading's utilities", () => {
        expect(result.css).toMatch(/\.text-5xl\s*\{[^}]*font-size:/);
        expect(result.css).toMatch(/\.font-bold\s*\{[^}]*font-weight:/);
        expect(result.css).toMatch(/\.tracking-tight\s*\{[^}]*letter-spacing:/);
    });

    it('generates no utility the sources do not use', () => {
        expect(result.css).not.toMatch(/\.text-9xl\s*\{/);
    });
});
