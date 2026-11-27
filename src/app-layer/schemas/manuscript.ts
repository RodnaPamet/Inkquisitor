/**
 * Request shapes for the manuscript API (Phase 5.1, D33). Every object is
 * `.strict()`. They bound the RAW input (at most `RAW_INPUT_FACTOR` times the
 * stored bound); the usecases sanitise every value before it is stored.
 */
import { z } from 'zod';
import { RAW_INPUT_FACTOR } from '@/lib/bible/field-values';
import {
    IMPORT_OVERRIDES_MAX,
    IMPORT_ROLES,
    MANUSCRIPT_TITLE_MAX,
    SCENE_BEATS_MAX,
    SCENE_LINKS_MAX,
    SCENE_NOTE_MAX,
    SCENE_TEXT_MAX_CHARS,
    STORY_TIME_MAX,
} from '@/lib/manuscript/vocabulary';

const id = z.string().min(1).max(64);
const raw = (max: number) => z.string().max(max * RAW_INPUT_FACTOR);
/** A save counter (PostgreSQL integer). */
export const RevisionInput = z.number().int().min(0).max(2_147_483_647);
const title = raw(MANUSCRIPT_TITLE_MAX).nullish();

/** Where a new or moved row goes: after a sibling, before one, or (neither) at the end. */
const placement = { after: id.nullish(), before: id.nullish() };

export const CreatePartInput = z.object({ title, ...placement }).strict();
export const RenameInput = z.object({ title: raw(MANUSCRIPT_TITLE_MAX).nullable() }).strict();
export const MovePartInput = z.object(placement).strict();

/** A chapter goes into a part; with none named, into the last part (made, untitled, when the manuscript has none). */
export const CreateChapterInput = z.object({ partId: id.optional(), title, ...placement }).strict();
export const MoveChapterInput = z.object({ partId: id, ...placement }).strict();

export const CreateSceneInput = z.object({ chapterId: id, title, ...placement }).strict();
export const MoveSceneInput = z.object({ chapterId: id, ...placement }).strict();

/** An autosave: the editor's whole HTML, the revision it was based on, and whether the author paused or left (a checkpoint, D33). */
export const SaveSceneTextInput = z
    .object({
        html: z.string().max(SCENE_TEXT_MAX_CHARS * RAW_INPUT_FACTOR),
        baseRevision: RevisionInput,
        checkpoint: z.boolean().optional(),
    })
    .strict();

/** A checkpoint with no text (sent with `keepalive` as the author leaves): version the stored text if it is the revision the tab last saved. */
export const CheckpointInput = z.object({ revision: RevisionInput }).strict();

/** The scene's details. A key left out is left as it is; `null` clears. */
export const SceneMetaInput = z
    .object({
        baseRevision: RevisionInput,
        title: title.optional(),
        povElementId: id.nullish(),
        settingElementId: id.nullish(),
        storyTime: raw(STORY_TIME_MAX).nullish(),
        linkedElementIds: z.array(id).max(SCENE_LINKS_MAX).optional(),
        beatElementIds: z.array(id).max(SCENE_BEATS_MAX).optional(),
    })
    .strict();

export const SaveSceneNoteInput = z.object({ note: raw(SCENE_NOTE_MAX), baseNoteVersion: RevisionInput }).strict();

export const RestoreSceneInput = z.object({ baseRevision: RevisionInput }).strict();

/** An import's confirmed split, sent in the `x-import-plan` header (base64url JSON) with the file again as the body. */
export const ImportPlanInput = z
    .object({
        token: z.string().min(1).max(200),
        issuedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        levels: z
            .object({
                part: z.number().int().min(1).max(6).nullable(),
                chapter: z.number().int().min(1).max(6).nullable(),
                scene: z.number().int().min(1).max(6).nullable(),
            })
            .strict(),
        sceneBreaks: z.boolean(),
        overrides: z.array(z.tuple([z.number().int().min(0).max(1_000_000), z.enum(IMPORT_ROLES)])).max(IMPORT_OVERRIDES_MAX),
    })
    .strict();
export type ImportPlanInput = z.infer<typeof ImportPlanInput>;

export const ManuscriptIdParam = id;

/** A delete's `confirmScenes` query parameter: the count of scenes the author was told goes with it (absent: none confirmed). */
export function confirmScenesParam(value: string | null): number | undefined {
    if (value === null || value === '') return undefined;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : undefined;
}
