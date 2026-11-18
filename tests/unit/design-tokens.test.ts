/**
 * src/styles/tokens.css — the palette contract.
 *
 * Rules followed from inflect-compliance's token guardrails
 * (`light-mode-parity`, `token-contrast-content-brand`, `token-css-integrity`;
 * see docs/carve-manifest.md), rewritten against Inkquisitor's palette:
 *
 *   - both themes define the same tokens (theme-independent scales aside);
 *   - every `var(--token)` the UI, the Tailwind config, the globals and the
 *     package's token contract read is defined, so no utility silently
 *     resolves to nothing (inflect's "transparent radio dot" defect);
 *   - text clears WCAG 2.x AA (4.5:1) on the surfaces it sits on, in both
 *     themes, and the accent clears it as text and as a primary-button fill;
 *   - `--border-strong`, the edge of a checkbox or radio, clears 3:1 on
 *     `--bg-default` in both themes (WCAG 1.4.11 non-text contrast);
 *   - the palette is Inkquisitor's own: ink black, parchment, one accent —
 *     no inflect brand colour survived the rebrand.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoFiles } from '../helpers/repo-files';

const ROOT = path.resolve(__dirname, '../..');
const css = fs.readFileSync(path.join(ROOT, 'src/styles/tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function block(selector: string): Record<string, string> {
    const start = css.indexOf(`${selector} {`);
    if (start < 0) throw new Error(`tokens.css: no "${selector}" block`);
    const end = css.indexOf('\n}', start);
    const out: Record<string, string> = {};
    for (const m of css.slice(start, end).matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    return out;
}

const dark = block(':root');
const light = block('[data-theme="light"]');
const THEME_INDEPENDENT = /^(radius|duration)(-|$)/;

type Rgb = [number, number, number];
function rgbOf(theme: Record<string, string>, token: string): Rgb {
    let value = theme[token] ?? dark[token];
    // Follow `var(--x)` aliases.
    for (let i = 0; value?.startsWith('var(') && i < 5; i++) {
        const name = /var\(--([a-z0-9-]+)\)/.exec(value)?.[1] ?? '';
        value = theme[name] ?? dark[name];
    }
    const hex = /^#([0-9a-f]{6})$/i.exec(value ?? '');
    if (!hex) throw new Error(`token --${token} is not an opaque hex colour: ${value}`);
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: Rgb): number {
    const ch = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a: Rgb, b: Rgb): number {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
}

describe('design tokens', () => {
    it('both themes define the same tokens', () => {
        const themed = (t: Record<string, string>) => Object.keys(t).filter((k) => !THEME_INDEPENDENT.test(k)).sort();
        expect(themed(light)).toEqual(themed(dark));
        expect(Object.keys(dark).length).toBeGreaterThan(60);
    });

    it('every var(--token) the UI reads is defined', () => {
        const readers = [
            ...repoFiles({ under: 'src', extensions: ['.ts', '.tsx', '.css'] }),
            ...repoFiles({ under: 'packages/ui/src', extensions: ['.ts', '.tsx'] }),
            path.join(ROOT, 'tailwind.config.js'),
        ].filter((f) => !f.endsWith('tokens.css'));
        // Variables a component declares for itself, or Radix / the sheet
        // primitive set at run time, are not theme tokens.
        const LOCAL = /^(radix-|sheet-|switch-|nav-shimmer-delay|nav-breath-delay|icon-|tw-)/;
        const defined = new Set([...Object.keys(dark), ...Object.keys(light)]);
        for (const f of readers) {
            for (const m of fs.readFileSync(f, 'utf8').matchAll(/--([a-z][a-z0-9-]*):/g)) defined.add(m[1]);
        }
        const missing = new Set<string>();
        for (const f of readers) {
            for (const m of fs.readFileSync(f, 'utf8').matchAll(/var\(--([a-z][a-z0-9-]*)/g)) {
                // A name ending in `-` is the static prefix of a template-built
                // one (`var(--brand-${tone})`), which no regex can resolve.
                if (!m[1].endsWith('-') && !LOCAL.test(m[1]) && !defined.has(m[1])) missing.add(m[1]);
            }
        }
        expect([...missing].sort()).toEqual([]);
    });

    it.each([
        ['dark', dark],
        ['light', light],
    ] as const)('%s: text clears WCAG AA on every surface it sits on', (_name, theme) => {
        const failures: string[] = [];
        for (const text of ['content-emphasis', 'content-default', 'content-muted', 'content-subtle', 'content-brand']) {
            for (const surface of ['bg-page', 'bg-default', 'bg-muted', 'bg-elevated']) {
                const ratio = contrast(rgbOf(theme, text), rgbOf(theme, surface));
                if (ratio < 4.5) failures.push(`${text} on ${surface}: ${ratio.toFixed(2)}`);
            }
        }
        // The primary button: inverted text on the accent fill, both stops.
        for (const fill of ['brand-default', 'brand-emphasis']) {
            const ratio = contrast(rgbOf(theme, 'content-inverted'), rgbOf(theme, fill));
            if (ratio < 4.5) failures.push(`content-inverted on ${fill}: ${ratio.toFixed(2)}`);
        }
        // Status text on the page.
        for (const status of ['content-success', 'content-warning', 'content-error', 'content-info']) {
            const ratio = contrast(rgbOf(theme, status), rgbOf(theme, 'bg-page'));
            if (ratio < 4.5) failures.push(`${status} on bg-page: ${ratio.toFixed(2)}`);
        }
        expect(failures).toEqual([]);
    });

    it.each([
        ['dark', dark],
        ['light', light],
    ] as const)('%s: --border-strong is an AA control edge (>= 3:1 on bg-default)', (_name, theme) => {
        // WCAG 1.4.11: the edge of an unchecked checkbox or radio is the only
        // thing that shows the control is there, so it needs 3:1 against the
        // surface it sits on. tests/rendered/checkbox-control-edge and
        // radio-group-control-edge pin that the controls ADOPT this token.
        expect(contrast(rgbOf(theme, 'border-strong'), rgbOf(theme, 'bg-default'))).toBeGreaterThanOrEqual(3);
    });

    it('the palette is ink black, parchment and one accent', () => {
        // Dark surfaces are near-black, light surfaces near-parchment, and the
        // text of each theme is the other theme's surface family.
        expect(luminance(rgbOf(dark, 'bg-page'))).toBeLessThan(0.01);
        expect(luminance(rgbOf(light, 'bg-page'))).toBeGreaterThan(0.8);
        const [r, g, b] = rgbOf(light, 'bg-page');
        expect(r).toBeGreaterThan(b); // warm (parchment), not a cold grey
        expect(g).toBeGreaterThan(b);
        // One accent: the brand family is the only saturated non-status hue,
        // and the "secondary" brand is a neutral, not a second accent.
        const saturation = ([R, G, B]: Rgb) => (Math.max(R, G, B) - Math.min(R, G, B)) / 255;
        expect(saturation(rgbOf(light, 'brand-default'))).toBeGreaterThan(0.25);
        expect(saturation(rgbOf(light, 'brand-secondary-default'))).toBeLessThan(0.25);
        expect(saturation(rgbOf(dark, 'brand-secondary-default'))).toBeLessThan(0.25);
    });

    it.each([
        ['dark', dark],
        ['light', light],
    ] as const)('%s: the chart series start on the accent and add no second accent', (_name, theme) => {
        const saturation = ([R, G, B]: Rgb) => (Math.max(R, G, B) - Math.min(R, G, B)) / 255;
        expect(rgbOf(theme, 'chart-series-1-start')).toEqual(rgbOf(theme, 'brand-default'));
        const accent = saturation(rgbOf(theme, 'brand-default'));
        for (let n = 2; n <= 6; n++) {
            for (const stop of ['start', 'end']) {
                const s = saturation(rgbOf(theme, `chart-series-${n}-${stop}`));
                expect({ token: `chart-series-${n}-${stop}`, below: s < 0.25 && s < accent }).toEqual({
                    token: `chart-series-${n}-${stop}`,
                    below: true,
                });
            }
        }
    });

    it('no inflect-compliance brand colour survived the rebrand', () => {
        // METRO yellow and navy (dark), signature orange (light), the indigo ramp.
        for (const inflect of ['#FFCD11', '#001830', '#003C7A', '#D04A02', '#B83D00', '#6366F1', '#4F46E5']) {
            expect(css.toUpperCase()).not.toContain(inflect);
        }
    });
});
