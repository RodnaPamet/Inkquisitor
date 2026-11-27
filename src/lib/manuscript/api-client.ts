/**
 * The browser's side of the manuscript API (Phase 5.1): one URL table for the
 * routes under `/api/w/<slug>/books/<bookId>/manuscript/**`. Requests go
 * through the bible's `bibleFetch` (a non-2xx answer throws `BibleApiError`
 * with its `details.reason`); the views are the usecases', imported as TYPES
 * only, so nothing server-side reaches the client bundle.
 *
 * An import sends the FILE as the body twice (preview, then confirm) and the
 * confirmed plan in the `x-import-plan` header, base64url JSON: never in the
 * URL. A checkpoint as the author leaves goes with `keepalive` (D33): it is a
 * few bytes, so it fits the browser's keepalive budget whatever the scene's length.
 *
 * Client-safe: no imports but types and the client-safe vocabulary.
 */
import type { OutlineView } from '@/app-layer/usecases/manuscript-common';
import type { BeatSceneView, SceneLinkView, SceneVersionMetaView, SceneVersionPage, SceneView } from '@/app-layer/usecases/manuscript-scenes';
import type { SceneTextResult } from '@/app-layer/usecases/manuscript-text';
import type { ImportPreviewView } from '@/app-layer/usecases/manuscript-import';
import type { ImportPlan } from './import-split';
import { answerOf } from '@/lib/bible/api-client';
import { IMPORT_PLAN_HEADER } from './vocabulary';

export type { OutlineView, BeatSceneView, SceneLinkView, SceneVersionMetaView, SceneVersionPage, SceneView, SceneTextResult, ImportPreviewView, ImportPlan };

const enc = encodeURIComponent;
const base = (slug: string, bookId: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}/manuscript`;

export const MANUSCRIPT_API = {
    outline: base,
    parts: (slug: string, bookId: string) => `${base(slug, bookId)}/parts`,
    part: (slug: string, bookId: string, partId: string, confirmScenes?: number) =>
        `${base(slug, bookId)}/parts/${enc(partId)}${confirmScenes !== undefined ? `?confirmScenes=${confirmScenes}` : ''}`,
    movePart: (slug: string, bookId: string, partId: string) => `${base(slug, bookId)}/parts/${enc(partId)}/move`,
    chapters: (slug: string, bookId: string) => `${base(slug, bookId)}/chapters`,
    chapter: (slug: string, bookId: string, chapterId: string, confirmScenes?: number) =>
        `${base(slug, bookId)}/chapters/${enc(chapterId)}${confirmScenes !== undefined ? `?confirmScenes=${confirmScenes}` : ''}`,
    moveChapter: (slug: string, bookId: string, chapterId: string) => `${base(slug, bookId)}/chapters/${enc(chapterId)}/move`,
    scenes: (slug: string, bookId: string) => `${base(slug, bookId)}/scenes`,
    scene: (slug: string, bookId: string, sceneId: string) => `${base(slug, bookId)}/scenes/${enc(sceneId)}`,
    moveScene: (slug: string, bookId: string, sceneId: string) => `${base(slug, bookId)}/scenes/${enc(sceneId)}/move`,
    text: (slug: string, bookId: string, sceneId: string) => `${base(slug, bookId)}/scenes/${enc(sceneId)}/text`,
    checkpoint: (slug: string, bookId: string, sceneId: string) => `${base(slug, bookId)}/scenes/${enc(sceneId)}/checkpoint`,
    note: (slug: string, bookId: string, sceneId: string) => `${base(slug, bookId)}/scenes/${enc(sceneId)}/note`,
    versions: (slug: string, bookId: string, sceneId: string, before?: number) => `${base(slug, bookId)}/scenes/${enc(sceneId)}/versions${before !== undefined ? `?before=${before}` : ''}`,
    version: (slug: string, bookId: string, sceneId: string, n: number) => `${base(slug, bookId)}/scenes/${enc(sceneId)}/versions/${n}`,
    restore: (slug: string, bookId: string, sceneId: string, n: number) => `${base(slug, bookId)}/scenes/${enc(sceneId)}/versions/${n}/restore`,
    importPreview: (slug: string, bookId: string) => `${base(slug, bookId)}/import/preview`,
    importConfirm: (slug: string, bookId: string) => `${base(slug, bookId)}/import`,
    /** A scene's prose check (5.2, D34): GET the margin's notes, POST to check it now. */
    proseChecks: (slug: string, bookId: string, sceneId: string) => `${base(slug, bookId)}/scenes/${enc(sceneId)}/prose-checks`,
    /** Re-run a chapter's prose checks. */
    chapterProseChecks: (slug: string, bookId: string, chapterId: string) => `${base(slug, bookId)}/chapters/${enc(chapterId)}/prose-checks`,
    /** POST dismiss one note `{ findingId }`; DELETE bring every dismissed note back. */
    proseDismissals: (slug: string, bookId: string) => `${base(slug, bookId)}/prose-checks/dismissals`,
    /** GET / PUT the book's prose-check settings. */
    proseSettings: (slug: string, bookId: string) => `${base(slug, bookId)}/prose-checks/settings`,
    /** A plot beat's scenes (D33 item 2). */
    beatScenes: (slug: string, bookId: string, elementId: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}/elements/${enc(elementId)}/scenes`,
} as const;

/** A file as the request body, its name in the `x-source-filename` header, and (confirm) the plan in `x-import-plan`. */
export async function uploadManuscript<T>(url: string, file: File, plan?: ImportPlan & { token: string; issuedAt: number }): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream', 'x-source-filename': encodeURIComponent(file.name) };
    if (plan) headers[IMPORT_PLAN_HEADER] = encodePlan(plan);
    const res = await fetch(url, { method: 'POST', headers, body: file, credentials: 'same-origin', cache: 'no-store' });
    return answerOf<T>(res);
}

/** The plan as base64url JSON (UTF-8 bytes first: the header is bytes, the JSON is ASCII anyway). */
export function encodePlan(plan: ImportPlan & { token: string; issuedAt: number }): string {
    const json = JSON.stringify({ token: plan.token, issuedAt: plan.issuedAt, levels: plan.levels, sceneBreaks: plan.sceneBreaks, overrides: plan.overrides });
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A checkpoint as the page goes (D33): small, so `keepalive` carries it past an unload. Never throws. */
export function sendCheckpointOnLeave(url: string, revision: number): void {
    try {
        void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision }), credentials: 'same-origin', keepalive: true }).catch(() => undefined);
    } catch {
        // Told, never asked: a page leaving cannot wait on it.
    }
}
