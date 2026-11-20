/**
 * The story maps a book has (Phase 3.1, decision D18): one relationship map,
 * one plot board and one timeline. Client-safe: it mirrors the `StoryMapKind`
 * enum (prisma/schema/enums.prisma) rather than importing `@prisma/client`,
 * and `tests/unit/canvas/map-kinds.test.ts` fails if the two drift.
 *
 * A map's URL names its kind in lower case (`…/maps/plot`); `mapKindFromSlug`
 * is the one reading of that segment, and anything else is no map at all.
 */
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
