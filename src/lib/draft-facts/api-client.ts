/**
 * The browser's side of the draft held against the bible and of the scene card (Phase 5.3, D35): the URL table over
 * the bible's `bibleFetch` (a refusal throws `BibleApiError` with its `details.reason`, which the pages word through
 * next-intl). Types only from the usecases. Client-safe.
 */
import { bibleFetch } from '@/lib/bible/api-client';
import type { SceneDraftNotesView } from '@/app-layer/usecases/draft-mismatches';
import type { SceneCardView, SceneCardValues } from '@/lib/manuscript/scene-card';
import type { DraftMismatchStatus, DraftUpdatePrefillView, LinkDecision, LinkStatus } from './vocabulary';

export type { SceneDraftNotesView };

const enc = encodeURIComponent;
const book = (slug: string, bookId: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}`;

export const DRAFT_API = {
    mismatchDecision: (slug: string, bookId: string, proposalId: string) => `${book(slug, bookId)}/draft-mismatches/${enc(proposalId)}/decision`,
    updateBible: (slug: string, bookId: string, proposalId: string) => `${book(slug, bookId)}/draft-mismatches/${enc(proposalId)}/update-bible`,
    linkDecision: (slug: string, bookId: string, linkId: string) => `${book(slug, bookId)}/thread-scene-links/${enc(linkId)}/decision`,
    sceneNotes: (slug: string, bookId: string, sceneId: string) => `${book(slug, bookId)}/manuscript/scenes/${enc(sceneId)}/draft-notes`,
    sceneCard: (slug: string, bookId: string, sceneId: string) => `${book(slug, bookId)}/manuscript/scenes/${enc(sceneId)}/card`,
} as const;

export const draftApi = {
    decideMismatch: (slug: string, bookId: string, proposalId: string, decision: 'FIX_DRAFT' | 'BOTH_TRUE', explanation?: string) =>
        bibleFetch<{ mismatch: { id: string; status: DraftMismatchStatus } }>(DRAFT_API.mismatchDecision(slug, bookId, proposalId), {
            method: 'POST',
            body: explanation === undefined ? { decision } : { decision, explanation },
        }),
    updatePrefill: (slug: string, bookId: string, proposalId: string) => bibleFetch<{ prefill: DraftUpdatePrefillView }>(DRAFT_API.updateBible(slug, bookId, proposalId)),
    saveUpdate: (slug: string, bookId: string, proposalId: string, baseVersion: number, value: unknown) =>
        bibleFetch<{ update: { versionNumber: number } }>(DRAFT_API.updateBible(slug, bookId, proposalId), { method: 'POST', body: { baseVersion, value } }),
    decideLink: (slug: string, bookId: string, linkId: string, decision: LinkDecision) =>
        bibleFetch<{ link: { id: string; status: LinkStatus } }>(DRAFT_API.linkDecision(slug, bookId, linkId), { method: 'POST', body: { decision } }),
    sceneNotes: (slug: string, bookId: string, sceneId: string) => bibleFetch<{ notes: SceneDraftNotesView }>(DRAFT_API.sceneNotes(slug, bookId, sceneId)),
    sceneCard: (slug: string, bookId: string, sceneId: string) => bibleFetch<{ card: SceneCardView }>(DRAFT_API.sceneCard(slug, bookId, sceneId)),
    saveSceneCard: (slug: string, bookId: string, sceneId: string, baseVersion: number, values: SceneCardValues) =>
        bibleFetch<{ card: SceneCardView }>(DRAFT_API.sceneCard(slug, bookId, sceneId), { method: 'PUT', body: { baseVersion, ...values } }),
};
