/**
 * The bible's element kinds, in their fixed order (Phase 1.1).
 *
 * The list is CLOSED and mirrors the `BibleElementKind` enum
 * (prisma/schema/enums.prisma); `tests/unit/bible/templates.test.ts` fails if
 * the two drift. It is declared here, not imported from `@prisma/client`, so a
 * client component can read it.
 *
 * The ORDER is significant: a relation between two kinds is declared once, on
 * the template of the kind that comes first (`src/lib/bible/templates.ts`).
 * PLOT_BEAT (Phase 3.2, decision D22) sits straight after PLOT on purpose: a
 * beat then declares its own relations to the characters, settings, events
 * and objects it involves, and only the beat's plotline (`has_beat`) is
 * declared on PLOT.
 */
export const BIBLE_KINDS = [
    'PREMISE',
    'PLOT',
    'PLOT_BEAT',
    'CHARACTER',
    'SETTING',
    'THEME',
    'MOOD',
    'TEXTURE',
    'STYLE',
    'POV',
    'WORLD_RULE',
    'TIMELINE_EVENT',
    'FACTION',
    'OBJECT',
    'RESEARCH',
    'CUSTOM',
] as const;

export type BibleKind = (typeof BIBLE_KINDS)[number];

export function isBibleKind(value: unknown): value is BibleKind {
    return typeof value === 'string' && (BIBLE_KINDS as readonly string[]).includes(value);
}

/**
 * The kinds that carry a place in a story order (Phase 3.2, decision D22):
 * `BibleElement.orderRank`, a fractional rank (`./story-order.ts`). A plot
 * beat's order runs within its act; a timeline event's is the timeline axis.
 * The migration's CHECK names the same two.
 */
export const ORDERED_KINDS = ['PLOT_BEAT', 'TIMELINE_EVENT'] as const satisfies readonly BibleKind[];
export type OrderedKind = (typeof ORDERED_KINDS)[number];

export function isOrderedKind(kind: string): kind is OrderedKind {
    return (ORDERED_KINDS as readonly string[]).includes(kind);
}

/** The kind's position in the fixed order (0-based). */
export function kindRank(kind: BibleKind): number {
    return BIBLE_KINDS.indexOf(kind);
}

export const BIBLE_ELEMENT_STATUSES = ['DRAFT', 'IN_PROGRESS', 'SETTLED'] as const;
export type BibleElementStatus = (typeof BIBLE_ELEMENT_STATUSES)[number];

export const BOOK_STAGES = ['CONCEPT', 'PLANNING', 'DRAFTING', 'REVISING', 'PUBLISHING'] as const;
export type BookStage = (typeof BOOK_STAGES)[number];

export const BIBLE_VERSION_SOURCES = ['MANUAL', 'INTERVIEW', 'IMPORT', 'RESEARCH'] as const;
export type BibleVersionSource = (typeof BIBLE_VERSION_SOURCES)[number];

/** Field keys, relation keys and option values: lower snake case, at most 32 characters. */
export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
/** The longest element name (the API's bound; client-safe here so the relation picker can clamp its search, issue #29 item 6). */
export const ELEMENT_NAME_MAX = 120;

export const IDENTIFIER_MAX = 32;
