/**
 * dagre auto-layout (decision D18: dagre only); adapted from
 * inflect-compliance's `auto-layout-is-engine-free.test.ts` and
 * `canvas-auto-layout-selection.test.ts` (docs/carve-manifest.md).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeAutoLayout, type LayoutNode } from '@/lib/canvas/canvas-auto-layout';
import { REPO_ROOT } from '../../helpers/repo-files';

const at = (id: string, x = 0, y = 0): LayoutNode => ({ id, position: { x, y }, width: 100, height: 40 });

it('a chain left to right puts each rank to the right of the last, top-left positions', () => {
    const { positions } = computeAutoLayout([at('a'), at('b'), at('c')], [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }], 'LR');
    expect(positions.a.x).toBeLessThan(positions.b.x);
    expect(positions.b.x).toBeLessThan(positions.c.x);
    // Same rank height in LR: one row.
    expect(positions.a.y).toBeCloseTo(positions.b.y);
});

it('top to bottom stacks the ranks instead', () => {
    const { positions } = computeAutoLayout([at('a'), at('b')], [{ source: 'a', target: 'b' }], 'TB');
    expect(positions.a.y).toBeLessThan(positions.b.y);
    expect(positions.a.x).toBeCloseTo(positions.b.x);
});

it('a selection is laid out alone and re-centred where it was; others are left out of the result', () => {
    const nodes = [at('a', 1000, 1000), at('b', 1200, 1000), at('c', -50, -50)];
    const { positions } = computeAutoLayout(nodes, [{ source: 'a', target: 'b' }, { source: 'c', target: 'a' }], 'LR', new Set(['a', 'b']));
    expect(Object.keys(positions).sort()).toEqual(['a', 'b']);
    const cx = (positions.a.x + positions.b.x) / 2;
    const cy = (positions.a.y + positions.b.y) / 2;
    expect(cx).toBeCloseTo(1100);
    expect(cy).toBeCloseTo(1000);
});

it('a node of unknown size gets the default size; a self edge is ignored', () => {
    const { positions } = computeAutoLayout([{ id: 'a', position: { x: 0, y: 0 } }], [{ source: 'a', target: 'a' }], 'LR');
    expect(positions.a).toEqual({ x: expect.any(Number), y: expect.any(Number) });
});

it('elk is not carried: no import of it anywhere, and no dependency on it (D18)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty('elkjs');
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/lib/canvas/canvas-auto-layout.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]elkjs/);
});
