/**
 * An element's version history: list, read one, restore one (Phase 1.1).
 *
 * Versions are written by the saves themselves (`bible-common.ts`,
 * `recordVersion`), never here, and are append-only in the database (a
 * trigger refuses UPDATE and DELETE). A RESTORE does not rewind: it applies
 * the old snapshot to the element as a NEW save, in one transaction under the
 * element's lock, and appends a new version whose snapshot equals the old one
 * (`source: MANUAL`, `restoredFromVersion` naming it; its change summary is
 * the author's, or null — never product text, which the UI words from
 * `restoredFromVersion`). Nothing before it is
 * touched, so a restore can itself be undone by restoring again.
 *
 * Restored values go through the same sanitiser and template checks as a
 * manual save: the summary through `optionalBlock`, fields through
 * `writeFieldValues` (`normaliseFieldValue`). A field the kind's template no
 * longer has, or whose stored value its current type refuses, is left out and
 * counted (`skippedFieldKeys`); the slug is restored only while no other
 * element of the book has taken it (`slugKept`), including one that takes it
 * between the check and the write (the restore is retried once, and keeps
 * the current slug).
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository, BibleVersionRepository } from '@/app-layer/repositories/bible.repository';
import { CUSTOM_LABEL_MAX, ELEMENT_NAME_MAX, ELEMENT_SUMMARY_MAX, RestoreInput, VersionNumberParam } from '@/app-layer/schemas/bible';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError } from '@/lib/errors/types';
import { normaliseFieldValue } from '@/lib/bible/field-values';
import { parseSnapshot, type BibleSnapshot } from '@/lib/bible/snapshot';
import { getFieldDef, getTemplate } from '@/lib/bible/templates';
import { assertBaseVersion, isUniqueViolation, optionalBlock, readFieldValues, recordVersion, requireElement, requiredLine, slugConflict, writeFieldValues } from './bible-common';

export interface VersionMetaView {
    versionNumber: number;
    changeSummary: string | null;
    source: string;
    restoredFromVersion: number | null;
    authorId: string | null;
    createdAt: string;
}

export interface VersionView extends VersionMetaView {
    snapshot: BibleSnapshot;
}

type VersionRow = Awaited<ReturnType<typeof BibleVersionRepository.create>>;

function metaView(v: VersionRow): VersionMetaView {
    return {
        versionNumber: v.versionNumber,
        changeSummary: v.changeSummary,
        source: v.source,
        restoredFromVersion: v.restoredFromVersion,
        authorId: v.authorId,
        createdAt: v.createdAt.toISOString(),
    };
}

export const VERSION_PAGE_MAX = 100;

export async function listVersions(
    ctx: WorkspaceRequestContext,
    bookId: string,
    elementId: string,
    options: { take?: number; before?: number } = {},
): Promise<VersionMetaView[]> {
    await assertPermission(ctx, 'bible.view');
    const take = Math.min(Math.max(options.take ?? 50, 1), VERSION_PAGE_MAX);
    // A version number, so within PostgreSQL's integer: past it the query fails P2020 (a 500).
    const before = VersionNumberParam.optional().parse(options.before);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireElement(db, ctx, bookId, elementId);
        const rows = await BibleVersionRepository.list(db, ctx.workspaceId, bookId, elementId, { take, beforeVersion: before });
        return rows.map(metaView);
    });
}

export async function getVersion(ctx: WorkspaceRequestContext, bookId: string, elementId: string, versionNumber: unknown): Promise<VersionView> {
    await assertPermission(ctx, 'bible.view');
    const n = VersionNumberParam.parse(versionNumber);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireElement(db, ctx, bookId, elementId);
        const row = await BibleVersionRepository.find(db, ctx.workspaceId, bookId, elementId, n);
        if (!row) throw new NotFoundError('Version not found.');
        return { ...metaView(row), snapshot: parseSnapshot(row.snapshot) };
    });
}

export interface RestoreResult {
    version: VersionMetaView;
    restoredFromVersion: number;
    skippedFieldKeys: string[];
    slugKept: boolean;
}

export async function restoreVersion(
    ctx: WorkspaceRequestContext,
    bookId: string,
    elementId: string,
    versionNumber: unknown,
    input: unknown,
): Promise<RestoreResult> {
    await assertPermission(ctx, 'bible.edit');
    const n = VersionNumberParam.parse(versionNumber);
    const { changeSummary, baseVersion } = RestoreInput.parse(input ?? {});
    const restore = () =>
        runInWorkspaceContext(ctx, async (db) => {
            // A restore can give the element back an old NAME, so it takes the
            // book's names lock as every rename does, and in its order (before
            // the element's): a concurrent accept's "the book holds no such
            // name" check cannot then race it (issues #39 item 5, #41 item 5).
            await BibleElementRepository.lockNames(db, bookId);
            await BibleElementRepository.lock(db, elementId);
            const element = await requireElement(db, ctx, bookId, elementId);
            await assertBaseVersion(db, ctx, elementId, baseVersion);
            const row = await BibleVersionRepository.find(db, ctx.workspaceId, bookId, elementId, n);
            if (!row) throw new NotFoundError('Version not found.');
            const snapshot = parseSnapshot(row.snapshot);
            if (snapshot.element.kind !== element.kind) {
                throw new ConflictError('That version belongs to an element of another kind.', { reason: 'KIND_MISMATCH' });
            }

            // The element's own columns, through the same sanitisers as a manual save.
            const slugFree = !(await BibleElementRepository.slugTaken(db, ctx.workspaceId, bookId, snapshot.element.slug, elementId));
            await BibleElementRepository.update(db, ctx.workspaceId, bookId, elementId, {
                name: requiredLine(snapshot.element.name, ELEMENT_NAME_MAX, 'Name'),
                ...(slugFree ? { slug: snapshot.element.slug } : {}),
                status: snapshot.element.status,
                summary: optionalBlock(snapshot.element.summary, ELEMENT_SUMMARY_MAX, 'Summary') ?? null,
                customLabel: element.kind === 'CUSTOM' ? requiredLine(snapshot.element.customLabel ?? '', CUSTOM_LABEL_MAX, 'Custom label') : null,
            });

            // The fields: every template field set to the snapshot's value, or cleared.
            const restorable = new Map<string, unknown>();
            const skippedFieldKeys: string[] = [];
            for (const f of snapshot.fields) {
                const def = getFieldDef(element.kind, f.key);
                if (!def || !normaliseFieldValue(def, f.value).ok) skippedFieldKeys.push(f.key);
                else restorable.set(f.key, f.value);
            }
            const current = await readFieldValues(db, ctx, elementId);
            const entries = getTemplate(element.kind)
                .fields.filter((f) => restorable.has(f.key) || current.has(f.key))
                .map((f) => ({ key: f.key, value: restorable.has(f.key) ? restorable.get(f.key) : null }));
            await writeFieldValues(db, ctx, element, entries);

            const version = await recordVersion(db, ctx, bookId, elementId, {
                source: 'MANUAL',
                // Author data holds only the author's words: a restore with none
                // stores null, and the history labels it from `restoredFromVersion`.
                changeSummary: changeSummary ?? null,
                restoredFromVersion: n,
            });
            await logEvent(
                ctx,
                {
                    action: 'BIBLE_VERSION_RESTORED',
                    entityType: 'BibleElement',
                    entityId: elementId,
                    details: {
                        bookId,
                        restoredFromVersion: n,
                        versionNumber: version.versionNumber,
                        skippedFieldCount: skippedFieldKeys.length,
                        slugKept: !slugFree,
                    },
                },
                { db },
            );
            return { version: metaView(version), restoredFromVersion: n, skippedFieldKeys, slugKept: !slugFree };
        });
    // The slug is checked, then written: another element can take it in
    // between. That write breaks the unique index and rolls the whole restore
    // back; the second attempt reads the slug as taken and keeps the current
    // one (`slugKept`), as a restore that found it taken would have.
    try {
        return await restore();
    } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        try {
            return await restore();
        } catch (again) {
            if (isUniqueViolation(again)) throw slugConflict();
            throw again;
        }
    }
}
