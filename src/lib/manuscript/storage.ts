/**
 * The manuscript's plain author text, sanitised for storage (Phase 5.1): a
 * part's, chapter's or scene's title, a scene's story time (one line each) and
 * its note (paragraphs kept). Each over `plainLine` / `plainBlock`
 * (`sanitizePlainText`), bounded on what is left: past the bound is
 * `ManuscriptTextTooLongError`, which the usecase answers 400 TOO_LONG naming
 * the part. A blank result is `null` (cleared). The scene's TEXT is the prose
 * profile's (`scene-html.ts`), never these.
 */
import { plainBlock, plainLine } from '@/lib/bible/text';
import { MANUSCRIPT_TITLE_MAX, SCENE_NOTE_MAX, STORY_TIME_MAX } from './vocabulary';
import { SCENE_CARD_FIELD_MAX, type SceneCardValues } from './scene-card';

export class ManuscriptTextTooLongError extends Error {
    constructor(readonly what: 'title' | 'storyTime' | 'note' | 'text' | 'card') {
        super(`manuscript ${what} too long`);
        this.name = 'ManuscriptTextTooLongError';
    }
}

/** A title as stored: one line, at most `MANUSCRIPT_TITLE_MAX`; blank is null (untitled). */
export function sanitiseManuscriptTitle(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    const value = plainLine(raw);
    if (value.length > MANUSCRIPT_TITLE_MAX) throw new ManuscriptTextTooLongError('title');
    return value === '' ? null : value;
}

/** A story time as stored: one line, at most `STORY_TIME_MAX`; blank is null (unstated). */
export function sanitiseStoryTime(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    const value = plainLine(raw);
    if (value.length > STORY_TIME_MAX) throw new ManuscriptTextTooLongError('storyTime');
    return value === '' ? null : value;
}

/** A scene note as stored: paragraphs kept, at most `SCENE_NOTE_MAX`; blank is '' (cleared). */
export function sanitiseSceneNote(raw: string | null | undefined): string {
    if (raw == null) return '';
    const value = plainBlock(raw);
    if (value.length > SCENE_NOTE_MAX) throw new ManuscriptTextTooLongError('note');
    return value;
}

/** A scene card's field as stored (Phase 5.3): paragraphs kept, at most `SCENE_CARD_FIELD_MAX`; blank is null (cleared). */
export function sanitiseSceneCardField(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    const value = plainBlock(raw);
    if (value.length > SCENE_CARD_FIELD_MAX) throw new ManuscriptTextTooLongError('card');
    return value === '' ? null : value;
}

/** A card version's snapshot: the card's four (already sanitised) fields as one JSON string, sealed whole. */
export function serialiseSceneCardSnapshot(card: SceneCardValues): string {
    return JSON.stringify({ goal: card.goal, conflict: card.conflict, outcome: card.outcome, change: card.change });
}
