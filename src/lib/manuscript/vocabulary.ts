/**
 * The manuscript's closed lists and bounds (Phase 5.1, decision D33),
 * client-safe: no imports.
 *
 *   bounds             parts, chapters and scenes a manuscript holds; a scene's
 *                      text, title, story time and note; the links a scene names
 *   SCENE_VERSION_*    when the server writes a version of a scene's text (D33:
 *                      at a checkpoint the client signals — the author paused
 *                      or left — or when the newest version is older than the
 *                      bound, so a lost signal still bounds a gap in history)
 *   MANUSCRIPT_REASONS every refusal code the manuscript routes answer with
 *                      (`details.reason`), worded by `manuscript.reasons`
 *   IMPORT_ROLES       what a heading becomes in an import's confirmed split
 */

/** Parts a manuscript holds at most. */
export const PARTS_PER_MANUSCRIPT_MAX = 100;
/** Chapters a manuscript holds at most (over all its parts). */
export const CHAPTERS_PER_MANUSCRIPT_MAX = 1_000;
/** Scenes a manuscript holds at most (over all its chapters). */
export const SCENES_PER_MANUSCRIPT_MAX = 5_000;

/** A part's, chapter's or scene's title, stored (after sanitising). */
export const MANUSCRIPT_TITLE_MAX = 200;
/** A scene's story time, stored (free text, as a timeline event's). */
export const STORY_TIME_MAX = 200;
/** A scene's note, stored (plain text; research notes are appended here). */
export const SCENE_NOTE_MAX = 20_000;
/** A scene's text, stored: sanitised HTML characters (about 50,000 words of prose). */
export const SCENE_TEXT_MAX_CHARS = 400_000;
/** Explicit links a scene names at most (mentions are counted with them). */
export const SCENE_LINKS_MAX = 100;
/** Plot beats a scene dramatises at most. */
export const SCENE_BEATS_MAX = 12;

/**
 * THE SERVER'S BOUND ON A GAP IN HISTORY (D33). A save whose text differs from
 * the newest version writes a version when the client says "checkpoint" (the
 * author paused about two minutes, or left the scene), or when the newest
 * version is older than this — so a checkpoint signal the network lost never
 * leaves more than this much writing outside the history. Thirty minutes (D33
 * addendum, owner decision 2026-11-27, item C): long enough that a session the
 * pause and leave signals already cover is not cut into extra versions.
 */
export const SCENE_VERSION_MAX_GAP_MS = 30 * 60_000;
/** The client's idle pause before it sends a checkpoint (about two minutes, D33). */
export const SCENE_IDLE_CHECKPOINT_MS = 2 * 60_000;
/** Versions a history page lists. */
export const SCENE_VERSION_PAGE_SIZE = 50;

/** Recently deleted scenes a manuscript's list shows at most (5.H-a; the rest are named as cut). */
export const DELETED_SCENES_LISTED_MAX = 200;

/** Scenes a beat's list shows at most (the rest are counted and said). */
export const BEAT_SCENES_MAX = 50;

/** The outline reads at most this many rows of each level (the bounds above, plus one to know a cut). */
export const OUTLINE_READ_MAX = SCENES_PER_MANUSCRIPT_MAX + 1;

/** What a heading becomes in an import's split (the author confirms, D33). `text`: no break, its words join the section before. */
export const IMPORT_ROLES = ['part', 'chapter', 'scene', 'text'] as const;
export type ImportRole = (typeof IMPORT_ROLES)[number];

/** Overrides an import's confirmed split may carry (one per heading the author changed). */
export const IMPORT_OVERRIDES_MAX = 2_000;
/** Headings an import's preview lists at most (the rest are refused: a manuscript of more is not one book). */
export const IMPORT_HEADINGS_MAX = SCENES_PER_MANUSCRIPT_MAX;
/** How long an import's preview token is good for: the confirm must follow the preview. */
export const IMPORT_TOKEN_MAX_AGE_MS = 60 * 60_000;
/** The import plan travels in this header (base64url JSON, never the URL). */
export const IMPORT_PLAN_HEADER = 'x-import-plan';
/** The plan header's size at most, bytes. */
export const IMPORT_PLAN_HEADER_MAX = 12_000;

/**
 * Every refusal the manuscript routes give (`details.reason`). A new one goes
 * here and in `manuscript.reasons` (`tests/unit/manuscript/vocabulary.test.ts`).
 */
export const MANUSCRIPT_REASONS = [
    'VERSION_CONFLICT',
    'EMPTY',
    'TOO_LONG',
    'TOO_MANY_PARTS',
    'TOO_MANY_CHAPTERS',
    'TOO_MANY_SCENES',
    'TOO_MANY_LINKS',
    'TOO_MANY_BEATS',
    'ORDER_STALE',
    'ORDER_RANK_EXHAUSTED',
    'UNKNOWN_ELEMENT',
    'WRONG_KIND',
    'NOT_EMPTY',
    'NO_VERSION',
    'IMPORT_FORMAT',
    'IMPORT_EMPTY',
    'IMPORT_TOO_LARGE',
    'IMPORT_NO_CHAPTERS',
    'IMPORT_PLAN_INVALID',
    'IMPORT_PREVIEW_EXPIRED',
    'IMPORT_FILE_CHANGED',
    'BODY_TOO_LARGE',
    'UPLOAD_INFECTED',
    'SCAN_UNAVAILABLE',
    // The 4.0 reader's own refusals (DOCX and Markdown pass through it), answered as it names them.
    'SOURCE_TYPE',
    'SOURCE_NO_TEXT_LAYER',
    'SOURCE_ENCRYPTED',
    'SOURCE_EMPTY',
    'SOURCE_NOT_TEXT',
    'SOURCE_ARCHIVE_REFUSED',
    'SOURCE_XML_REFUSED',
    'SOURCE_PARSE_FAILED',
    'SOURCE_PARSE_TIMEOUT',
    'SOURCE_TOO_LONG',
] as const;
export type ManuscriptReason = (typeof MANUSCRIPT_REASONS)[number];

export const SCENE_VERSION_SOURCES = ['EDIT', 'RESTORE', 'IMPORT'] as const;
export type SceneVersionSource = (typeof SCENE_VERSION_SOURCES)[number];
