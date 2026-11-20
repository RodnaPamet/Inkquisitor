/**
 * A map's canonical state (Phase 3.1): the form a snapshot stores and a no-op
 * save is detected by, and the enum mirror the client reads.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STORY_MAP_KINDS, mapKindFromSlug, mapKindSlug } from '@/lib/canvas/map-kinds';
import { canonicalMapState, parseMapState, serialiseMapState, type MapState } from '@/lib/canvas/map-state';
import { REPO_ROOT } from '../../helpers/repo-files';

const state: MapState = {
    nodes: [
        { elementId: 'b', x: 1, y: 2, w: 3, h: 4, lane: null },
        { elementId: 'a', x: 5, y: 6, w: 7, h: 8, lane: 'l' },
    ],
    edges: [
        { relationId: 'r2', sourceElementId: 'a', targetElementId: 'b' },
        { relationId: 'r1', sourceElementId: 'b', targetElementId: 'a' },
    ],
    freeform: [{ id: 'shape:x', typeName: 'shape' }],
};

it('the same state in any order serialises the same; a different one does not', () => {
    const shuffled: MapState = { ...state, nodes: [...state.nodes].reverse(), edges: [...state.edges].reverse() };
    expect(serialiseMapState(shuffled)).toBe(serialiseMapState(state));
    expect(serialiseMapState({ ...state, nodes: [{ ...state.nodes[0], x: 9 }, state.nodes[1]] })).not.toBe(serialiseMapState(state));
    expect(canonicalMapState(state).nodes.map((n) => n.elementId)).toEqual(['a', 'b']);
});

it('a snapshot reads back to its state; garbage reads as null, never a throw', () => {
    expect(parseMapState(serialiseMapState(state))).toEqual(canonicalMapState(state));
    expect(parseMapState('{')).toBeNull();
    expect(parseMapState('{"nodes":"no"}')).toBeNull();
});

it('the client’s map kinds mirror the StoryMapKind enum, and their URL segments round-trip', () => {
    const enums = fs.readFileSync(path.join(REPO_ROOT, 'prisma/schema/enums.prisma'), 'utf8');
    const block = /enum StoryMapKind \{([^}]*)\}/.exec(enums)?.[1] ?? '';
    expect(block.split(/\s+/).filter(Boolean)).toEqual([...STORY_MAP_KINDS]);
    for (const k of STORY_MAP_KINDS) expect(mapKindFromSlug(mapKindSlug(k))).toBe(k);
    expect(mapKindFromSlug('RELATIONSHIP')).toBeNull();
    expect(mapKindFromSlug('scenes')).toBeNull();
});
