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
 */
export const BIBLE_KINDS = [
    'PREMISE',
    'PLOT',
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

/** The kind's position in the fixed order (0-based). */
export function kindRank(kind: BibleKind): number {
    return BIBLE_KINDS.indexOf(kind);
}

export const BIBLE_ELEMENT_STATUSES = ['DRAFT', 'IN_PROGRESS', 'SETTLED'] as const;
export type BibleElementStatus = (typeof BIBLE_ELEMENT_STATUSES)[number];

export const BOOK_STAGES = ['CONCEPT', 'PLANNING', 'DRAFTING', 'REVISING', 'PUBLISHING'] as const;
export type BookStage = (typeof BOOK_STAGES)[number];

export const BIBLE_VERSION_SOURCES = ['MANUAL', 'INTERVIEW', 'IMPORT'] as const;
export type BibleVersionSource = (typeof BIBLE_VERSION_SOURCES)[number];

/** Field keys, relation keys and option values: lower snake case, at most 32 characters. */
export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
export const IDENTIFIER_MAX = 32;
