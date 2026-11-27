/**
 * A SCENE'S CARD (Phase 5.3): what the scene is for — the point-of-view character's GOAL in it, the CONFLICT in the
 * way, its OUTCOME, and WHAT CHANGED by its end. Client-safe: the fields, their bounds and their order. Never the
 * scene's prose (D3): "Grill me on this scene" fills these, and only these.
 *
 * The card's fields are template fields (`FieldDef`, prose `text`), so the interview engine asks about them as it asks
 * about an element's or a relation's (`subjects.ts`), the scene being the subject; labels are original, neutral craft
 * words.
 */
import type { FieldDef } from '@/lib/bible/template-schema';

export const SCENE_CARD_FIELD_KEYS = ['goal', 'conflict', 'outcome', 'change'] as const;
export type SceneCardFieldKey = (typeof SCENE_CARD_FIELD_KEYS)[number];

/** A card field, at most (characters, after sanitising). */
export const SCENE_CARD_FIELD_MAX = 2_000;
/** Card versions listed at most. */
export const SCENE_CARD_VERSIONS_LISTED = 20;

/** The card's fields as the engine and the editor read them: prose, in order, the goal first. */
export const SCENE_CARD_FIELDS: readonly FieldDef[] = Object.freeze<FieldDef[]>([
    { key: 'goal', label: 'Goal', type: 'text', required: true, order: 1, dependsOn: [], help: 'What the point-of-view character wants in this scene.' },
    { key: 'conflict', label: 'Conflict', type: 'text', required: true, order: 2, dependsOn: ['goal'], help: 'What stands in the way of that want here.' },
    { key: 'outcome', label: 'Outcome', type: 'text', required: true, order: 3, dependsOn: ['conflict'], help: 'How the scene ends for them: yes, no, yes but, no and.' },
    { key: 'change', label: 'What changed', type: 'text', required: true, order: 4, dependsOn: [], help: 'What is different by the end of the scene: a value, a relation, what someone knows.' },
]);

export function isSceneCardField(key: string): key is SceneCardFieldKey {
    return (SCENE_CARD_FIELD_KEYS as readonly string[]).includes(key);
}

export interface SceneCardValues {
    goal: string | null;
    conflict: string | null;
    outcome: string | null;
    change: string | null;
}

export interface SceneCardView extends SceneCardValues {
    sceneId: string;
    version: number;
    versions: Array<{ versionNumber: number; source: 'MANUAL' | 'INTERVIEW'; createdAt: string }>;
}

/** The element a scene's card questions are filed under: its point of view, else its setting, else a beat, else a linked element. */
export function sceneCarrierOf(scene: { povElementId: string | null; settingElementId: string | null; beatLinks: ReadonlyArray<{ beatElementId: string }>; elementLinks: ReadonlyArray<{ elementId: string }> }): string | null {
    return scene.povElementId ?? scene.settingElementId ?? scene.beatLinks[0]?.beatElementId ?? scene.elementLinks[0]?.elementId ?? null;
}
