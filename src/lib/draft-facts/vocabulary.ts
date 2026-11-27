/**
 * THE DRAFT HELD AGAINST THE BIBLE — its words (Phase 5.3, D35). Client-safe:
 * bounds, codes and wire types only (no server import).
 *
 * The nightly pass reads each scene whose text changed since it was last read,
 * drawing DRAFT facts from it (StoryFacts of kind SCENE_TEXT, never canon), and
 * compares them with the bible's facts by 4.2's rules: a mismatch is a
 * StoryFactProposal of basis DRAFT the author decides with one of three
 * choices. It also proposes which threads the scene plants or pays off.
 */
import type { FieldDef } from '@/lib/bible/template-schema';

/** A draft note's id in the scene editor (`draft:<mismatchId>`), distinct from every prose finding's. */
export const DRAFT_NOTE_PREFIX = 'draft:';

/** The author's three choices on a draft mismatch (D35 item 3; the roadmap's 5.3). */
export const DRAFT_DECISIONS = ['FIX_DRAFT', 'UPDATE_BIBLE', 'BOTH_TRUE'] as const;
export type DraftDecision = (typeof DRAFT_DECISIONS)[number];

/**
 * A draft mismatch's statuses: PENDING (nobody decided), FIX_PENDING (the author will fix the draft), FIXED (a re-read
 * no longer finds the claim — settled whether or not the author chose to fix it), BIBLE_UPDATED (the author's own save
 * of the field, naming the scene), KEPT (both true, explained), INVALIDATED (the bible fact was set aside meanwhile).
 */
export const DRAFT_MISMATCH_STATUSES = ['PENDING', 'FIX_PENDING', 'FIXED', 'BIBLE_UPDATED', 'KEPT', 'INVALIDATED'] as const;
export type DraftMismatchStatus = (typeof DRAFT_MISMATCH_STATUSES)[number];
/** The statuses still shown as open (the author has something to do, or the draft has not been fixed yet). */
export const OPEN_DRAFT_STATUSES: readonly DraftMismatchStatus[] = ['PENDING', 'FIX_PENDING'];

/** A thread a scene plants or pays off (D35 item 4). */
export const LINK_ROLES = ['PLANTS', 'PAYS'] as const;
export type LinkRole = (typeof LINK_ROLES)[number];
export const LINK_DECISIONS = ['CONFIRM', 'REJECT'] as const;
export type LinkDecision = (typeof LINK_DECISIONS)[number];
export const LINK_STATUSES = ['PENDING', 'CONFIRMED', 'REJECTED'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

/** A run's states (as 4.2's). */
export const DRAFT_READ_RUN_STATUSES = ['QUEUED', 'RUNNING', 'DONE', 'STOPPED', 'SKIPPED', 'FAILED'] as const;
export type DraftReadRunStatus = (typeof DRAFT_READ_RUN_STATUSES)[number];

/** How a night's read of a book ended or paused (the run's `outcome`, CHECK-held). */
export const DRAFT_READ_OUTCOMES = [
    /** Every scene due was read (or found unchanged). */
    'OK',
    /** The night's bound was reached with scenes left: they are read the next night. Not a failure. */
    'PAGED',
    /** No scene was due (a quiet book costs nothing). */
    'NOTHING_TO_READ',
    'BOOK_DELETED',
    /** No member may edit the bible (no call is made on nobody's behalf). */
    'NO_ACTOR',
    /** The workspace's monthly ceiling (D10): resumable, never a failure. */
    'CEILING',
    /** The NIGHTLY SHARE (D35 item 2: draft reading and the continuity check together) is spent: resumable. */
    'NIGHTLY_CAP',
    'KILL_SWITCH',
    'AI_UNAVAILABLE',
    /** No evaluation record this deployment accepts (D11): nothing is read until one exists. */
    'NOT_EVALUATED',
    'MODEL_RATE_LIMITED',
    /** A call failed (an outage, a timeout): resumable; the scene is read again the next night. */
    'CALL_FAILED',
    'ABORTED',
    'CLAIM_EXPIRED',
    'INTERNAL',
] as const;
export type DraftReadOutcome = (typeof DRAFT_READ_OUTCOMES)[number];

/** A scene cursor's outcome (`SceneDraftRead.outcome`). */
export const SCENE_READ_OUTCOMES = ['OK', 'EMPTY', 'CALL_OVER_BUDGET', 'GUARD_REFUSED', 'PASSED_OVER'] as const;
export type SceneReadOutcome = (typeof SCENE_READ_OUTCOMES)[number];
/**
 * The cursor outcomes that record a READ of the cursor's text (its facts stand for that text). A cursor of any other
 * outcome, or one with a failure counted against its text (`failures` > 0: the text failed, nothing was read), has NOT
 * read it: a scene whose revision moved with that same text must be sent again (or stay passed over), never treated as
 * "unchanged".
 */
export const SCENE_READ_DONE_OUTCOMES: readonly SceneReadOutcome[] = ['OK', 'EMPTY', 'GUARD_REFUSED'];
export function cursorReadItsText(cursor: { outcome: string | null; failures: number; revision?: number }): boolean {
    return cursor.failures === 0 && (cursor.revision ?? 0) >= 0 && (SCENE_READ_DONE_OUTCOMES as readonly string[]).includes(cursor.outcome ?? '');
}

/** The night's draft reading runs at 03:07 UTC, AFTER the continuity check (02:23): the order is the 5.3 note's. */
export const DRAFT_DISPATCH_CRON = '7 3 * * *';
/** Books queued at most by one dispatch. */
export const DRAFT_DISPATCH_MAX = 500;
/** A run with no sign of life for this long is ended (CLAIM_EXPIRED) and the book queued again. */
export const STALE_DRAFT_RUN_MS = 6 * 60 * 60 * 1000;

/** Model calls one book's night may make at most (a 150,000-word manuscript reads over about four nights). */
export const DRAFT_CALLS_PER_NIGHT = 60;
/** Scenes read at most a night (a book of more continues the next night, least recently read first). */
export const DRAFT_SCENES_PER_NIGHT = 200;
/** A scene's text read at most (characters of its plain text); past it the rest is unread and the cut named (`textCut`). */
export const DRAFT_TEXT_MAX_CHARS = 60_000;
/** One call's piece of a scene, at most (characters), and the floor halving stops at. */
export const DRAFT_PIECE_MAX_CHARS = 12_000;
export const DRAFT_PIECE_MIN_CHARS = 1_500;
/** Nights in a row a scene's text may fail in a way it will fail every night before it is passed over (as 4.2's pages). */
export const DRAFT_SCENE_FAILURES_MAX = 3;
/** Live bible facts a night's read compares against, at most (one more is asked, so a cut is known). */
export const DRAFT_BIBLE_FACTS_READ_MAX = 4_000;
/** Mismatches a night raises for one book at most (a safety bound, as 4.2's). */
export const DRAFT_MISMATCHES_PER_RUN_MAX = 1_000;
/** Thread links one call may propose at most. */
export const LINKS_PER_CALL_MAX = 6;
/** Open threads shown to a call at most (numbered). */
export const DRAFT_THREADS_SHOWN_MAX = 20;

/** A list on the Continuity page or in the margin, at most (one more is asked, so a cut is named). */
export const DRAFT_LIST_MAX = 100;
/** An explanation of "both true", at most (4.2's bound). */
export const DRAFT_EXPLANATION_MAX = 600;

/** The refusals a draft-mismatch or link request may answer, by `details.reason` (worded in `continuity.draft.errors`). */
export const DRAFT_REASONS = [
    'PROPOSAL_DECIDED',
    'NOT_A_DRAFT_MISMATCH',
    'EXPLANATION_REQUIRED',
    'BIBLE_FACT_GONE',
    'NO_FIELD_TO_UPDATE',
    'VERSION_CONFLICT',
    'LINK_DECIDED',
    'FIELD_VALUES_REFUSED',
] as const;
export type DraftReason = (typeof DRAFT_REASONS)[number];

// ─── Wire types (the Continuity page, the scene editor's margin, the update sheet) ───

export interface DraftFactSideView {
    statement: string;
    quote: string;
    subjectName: string;
    predicate: string;
}

export interface DraftMismatchView {
    id: string;
    status: DraftMismatchStatus;
    kind: string;
    createdAt: string;
    sceneId: string;
    sceneTitle: string | null;
    /** The draft's sentence, as last read, and where it stands in the scene's plain text (a stale offset is not placed). */
    draft: DraftFactSideView & { start: number; end: number; live: boolean };
    /** The bible fact it disagrees with, and its entry. */
    bible: DraftFactSideView & { elementId: string | null; elementName: string | null; versionNumber: number | null; live: boolean };
    /** "Update the bible" is offered (an element's fact, still live, whose field can be found). */
    canUpdateBible: boolean;
    explanation: string | null;
}

export interface SceneLinkView {
    id: string;
    threadId: string;
    threadTitle: string;
    threadKind: string;
    sceneId: string;
    sceneTitle: string | null;
    role: LinkRole;
    status: LinkStatus;
    quote: string;
    start: number;
    end: number;
    flags: string[];
    createdAt: string;
}

/** The draft reading's state for a book (the Continuity page): rule 6 — a manuscript never read is "not read yet". */
export interface DraftReadingView {
    /** Scenes with any text. */
    scenesWithText: number;
    /** Of those, read at their current text. */
    scenesRead: number;
    /** Scenes whose text changed since they were read, or never read. */
    scenesWaiting: number;
    /** Scenes passed over (a text that always fails, or over the per-call budget) until they change. */
    scenesPassedOver: number;
    lastRunAt: string | null;
    lastOutcome: DraftReadOutcome | null;
}

/** "Update the bible": the field the bible fact rests on, its current value and the draft's value prefilled. */
export interface DraftUpdatePrefillView {
    proposalId: string;
    elementId: string;
    elementName: string;
    fieldKey: string;
    fieldLabel: string;
    fieldType: string;
    /** The field's template definition (the update sheet's editor). */
    field: FieldDef;
    baseVersion: number;
    current: unknown;
    prefill: unknown;
    /** How the prefill was made: the bible's words replaced by the draft's, the draft's sentence added, or the field as it stands. */
    prefillBasis: 'REPLACED' | 'APPENDED' | 'UNCHANGED';
    draftQuote: string;
    sceneId: string;
    sceneTitle: string | null;
}
