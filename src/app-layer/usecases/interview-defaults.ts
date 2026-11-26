/**
 * Interview dial defaults (Phase 2.3): a workspace's and a book's, and the
 * dials a session runs with.
 *
 * PRECEDENCE, per dial: the session's own request, then the book's default,
 * then the workspace's, then the code default (`resolveDials`,
 * `src/lib/interview/dial-settings.ts`). A layer is replaced whole (PUT): each
 * dial a value, or null / left out to pass it on.
 *
 * PERMISSIONS. Reading a layer, and what it resolves to, is `bible.view`, as
 * reading an interview is. Setting one is `bible.edit`: a default only
 * changes how the next interviews are asked (prompts and budgets, never what
 * may be written to the bible), and whoever may run an interview may already
 * choose every dial for it, so a default gives an EDITOR nothing an EDITOR
 * cannot already do. That holds for the workspace's layer too: it is a
 * convenience over the book's, not a policy — a workspace setting that
 * constrained what an EDITOR may choose would be `workspace.manage`, and none
 * does.
 *
 * Every change is audited (`INTERVIEW_DEFAULTS_UPDATED`) with the keys set,
 * never a value that could be text (the values are codes and numbers anyway).
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { InterviewDefaultsRepository, type DefaultsRow, type DefaultsWrite } from '@/app-layer/repositories/interview-defaults.repository';
import { InterviewDefaultsInput } from '@/app-layer/schemas/interview';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import {
    DIAL_KEYS,
    dialEffects,
    isGeneratorList,
    isPersonaList,
    resolveDials,
    type DialEffects,
    type DialKey,
    type DialLayer,
    type DialSettings,
    type DialSource,
} from '@/lib/interview/dial-settings';
import { isDial } from '@/lib/interview/dials';
import { QUESTION_GENERATORS } from '@/lib/interview/vocabulary';
import { requireBook } from './bible-common';

/** A stored layer as the API shows it: each dial set, or null (passed on). */
export type DefaultsLayerView = { [K in DialKey]: DialSettings[K] | null };

export interface DefaultsView {
    /** This layer as stored. */
    stored: DefaultsLayerView;
    /** What a session started with no dials of its own would run with. */
    effective: DialSettings;
    /** Where each effective dial came from. */
    sources: Record<DialKey, DialSource>;
    /** What the effective dials do: the prompts and budgets they move. */
    effects: DialEffects;
}

const EMPTY_LAYER: DefaultsLayerView = { depth: null, detail: null, personaKeys: null, offerRecommended: null, preferChoice: null, generatorsOff: null };

/** A stored row as a layer. A value that is no longer acceptable reads as null (passed on), never used. */
export function layerOf(row: DefaultsRow | null): DefaultsLayerView {
    if (!row) return { ...EMPTY_LAYER };
    return {
        depth: isDial(row.depth) ? row.depth : null,
        detail: isDial(row.detail) ? row.detail : null,
        personaKeys: isPersonaList(row.personaKeys) ? [...row.personaKeys] : null,
        offerRecommended: row.offerRecommended,
        preferChoice: row.preferChoice,
        generatorsOff: isGeneratorList(row.generatorsOff) ? QUESTION_GENERATORS.filter((g) => (row.generatorsOff as string[]).includes(g)) : null,
    };
}

function writeOf(input: InterviewDefaultsInput): DefaultsWrite {
    return {
        depth: input.depth ?? null,
        detail: input.detail ?? null,
        personaKeys: input.personaKeys ?? null,
        offerRecommended: input.offerRecommended ?? null,
        preferChoice: input.preferChoice ?? null,
        generatorsOff: input.generatorsOff ?? null,
    };
}

function setKeys(layer: DefaultsLayerView): DialKey[] {
    return DIAL_KEYS.filter((k) => layer[k] !== null);
}

function viewOf(stored: DefaultsLayerView, layers: { book?: DialLayer | null; workspace?: DialLayer | null }): DefaultsView {
    const { settings, sources } = resolveDials(layers);
    return { stored, effective: settings, sources, effects: dialEffects(settings) };
}

/** The book's and the workspace's layers, for resolving a session's dials, in the caller's transaction. */
export async function defaultLayersFor(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string): Promise<{ book: DefaultsLayerView; workspace: DefaultsLayerView }> {
    const book = await InterviewDefaultsRepository.findForBook(db, ctx.workspaceId, bookId);
    const workspace = await InterviewDefaultsRepository.findForWorkspace(db, ctx.workspaceId);
    return { book: layerOf(book), workspace: layerOf(workspace) };
}

export async function getWorkspaceInterviewDefaults(ctx: WorkspaceRequestContext): Promise<DefaultsView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        const stored = layerOf(await InterviewDefaultsRepository.findForWorkspace(db, ctx.workspaceId));
        return viewOf(stored, { workspace: stored });
    });
}

export async function setWorkspaceInterviewDefaults(ctx: WorkspaceRequestContext, input: unknown): Promise<DefaultsView> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = InterviewDefaultsInput.parse(input ?? {});
    return runInWorkspaceContext(ctx, async (db) => {
        const stored = layerOf(await InterviewDefaultsRepository.upsertForWorkspace(db, ctx.workspaceId, writeOf(parsed)));
        await logEvent(
            ctx,
            { action: 'INTERVIEW_DEFAULTS_UPDATED', entityType: 'WorkspaceInterviewDefaults', entityId: ctx.workspaceId, details: { layer: 'WORKSPACE', set: setKeys(stored) } },
            { db },
        );
        return viewOf(stored, { workspace: stored });
    });
}

export async function getBookInterviewDefaults(ctx: WorkspaceRequestContext, bookId: string): Promise<DefaultsView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const layers = await defaultLayersFor(db, ctx, bookId);
        return viewOf(layers.book, layers);
    });
}

export async function setBookInterviewDefaults(ctx: WorkspaceRequestContext, bookId: string, input: unknown): Promise<DefaultsView> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = InterviewDefaultsInput.parse(input ?? {});
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const book = layerOf(await InterviewDefaultsRepository.upsertForBook(db, ctx.workspaceId, bookId, writeOf(parsed)));
        const workspace = layerOf(await InterviewDefaultsRepository.findForWorkspace(db, ctx.workspaceId));
        await logEvent(
            ctx,
            { action: 'INTERVIEW_DEFAULTS_UPDATED', entityType: 'BookInterviewDefaults', entityId: bookId, details: { layer: 'BOOK', bookId, set: setKeys(book) } },
            { db },
        );
        return viewOf(book, { book, workspace });
    });
}
