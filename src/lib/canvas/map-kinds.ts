/**
 * The story maps a book has (Phase 3.1, decision D18): one relationship map,
 * one plot board and one timeline. Client-safe: it mirrors the `StoryMapKind`
 * enum (prisma/schema/enums.prisma) rather than importing `@prisma/client`,
 * and `tests/unit/canvas/map-kinds.test.ts` fails if the two drift.
 *
 * A map's URL names its kind in lower case (`…/maps/plot`); `mapKindFromSlug`
 * is the one reading of that segment, and anything else is no map at all.
 */
import type { BibleKind } from '@/lib/bible/kinds';

export const STORY_MAP_KINDS = ['RELATIONSHIP', 'PLOT', 'TIMELINE'] as const;

export type StoryMapKindValue = (typeof STORY_MAP_KINDS)[number];

const SLUG_OF: Readonly<Record<StoryMapKindValue, string>> = {
    RELATIONSHIP: 'relationship',
    PLOT: 'plot',
    TIMELINE: 'timeline',
};

/** The URL segment for a kind. */
export function mapKindSlug(kind: StoryMapKindValue): string {
    return SLUG_OF[kind];
}

/** The kind a URL segment names, or null (an unknown segment is a 404, never a guess). */
export function mapKindFromSlug(slug: string): StoryMapKindValue | null {
    for (const kind of STORY_MAP_KINDS) if (SLUG_OF[kind] === slug) return kind;
    return null;
}

/**
 * The element kinds each map draws (Phase 3.2): the relationship map its
 * characters and factions, the plot board its plot beats, the timeline its
 * timeline events. `saveStoryMap` refuses any other (`KIND_NOT_ON_MAP`); the
 * picker offers only these.
 */
export const MAP_ELEMENT_KINDS: Readonly<Record<StoryMapKindValue, readonly BibleKind[]>> = {
    RELATIONSHIP: ['CHARACTER', 'FACTION'],
    PLOT: ['PLOT_BEAT'],
    TIMELINE: ['TIMELINE_EVENT'],
};

export function mapTakesKind(map: StoryMapKindValue, kind: string): boolean {
    return (MAP_ELEMENT_KINDS[map] as readonly string[]).includes(kind);
}

/** The maps that draw an element of `kind` (its page's embedded views). */
export function mapsDrawingKind(kind: string): StoryMapKindValue[] {
    return STORY_MAP_KINDS.filter((m) => mapTakesKind(m, kind));
}

/**
 * How a map places its nodes. `free`: wherever the author put them (the
 * relationship map). `derived`: from the bible — the plot board's acts and
 * order, the timeline's order — so a node's position is never the map's own
 * (`src/lib/canvas/lanes.ts`).
 */
export type MapLayoutMode = 'free' | 'derived';

export function mapLayoutMode(map: StoryMapKindValue): MapLayoutMode {
    return map === 'RELATIONSHIP' ? 'free' : 'derived';
}
