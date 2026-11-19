/**
 * A book's bible, exported (Phase 1.3): as a zipped Markdown bundle
 * (`src/lib/bible/bundle-format.ts`) or as one PDF
 * (`src/lib/bible/bible-pdf.ts`). Both need `bible.view`, read the whole
 * bible in one transaction, and write an audit row (format and counts, no
 * text).
 *
 * WHAT IS EXPORTED. The book's details; every element with its columns, its
 * filled fields whose keys the kind's CURRENT template has (a value stored
 * under a key a template has since dropped stays in the element's history,
 * not in the export, because an import would refuse the key); every
 * relation, written once, in the file of the element that stores it. Version
 * history is not exported: a bundle is the bible as it stands.
 *
 * BOUNDED, NEVER TRUNCATED. A book with more than `BUNDLE_MAX_ELEMENTS`
 * elements or `BUNDLE_MAX_RELATIONS` relations is refused
 * (`EXPORT_TOO_LARGE`): each read asks for one more than the bound, so a cut
 * is a fact the usecase holds, and an export never silently leaves anything
 * out. So is a bundle whose bytes the import would refuse (past the upload
 * bound, or a file or the whole past the zip reader's inflated bounds): an
 * export is only ever an archive the import takes back.
 *
 * Nothing is stored: the files are built in memory and handed to the
 * response. The bundle's bytes are a function of the bible alone (no time,
 * no id), so exporting an unchanged bible twice gives the same file.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository, BibleFieldRepository, BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
import { WorkspaceRepository } from '@/app-layer/repositories/workspace.repository';
import { BUNDLE_MAX_ELEMENTS, BUNDLE_MAX_RELATIONS, BUNDLE_UPLOAD_MAX_BYTES, BUNDLE_ZIP_LIMITS } from '@/app-layer/schemas/bible-transfer';
import { readZip, writeZip, ZipRefusal } from '@/lib/archive/zip';
import { renderBiblePdf } from '@/lib/bible/bible-pdf';
import { bundleFiles, type BibleBundle, type BundleElement, type BundleRelation } from '@/lib/bible/bundle-format';
import { decodeFieldValue, type FieldValue } from '@/lib/bible/field-values';
import type { BibleElementStatus, BookStage } from '@/lib/bible/kinds';
import { slugify } from '@/lib/bible/slug';
import { getFieldDef } from '@/lib/bible/templates';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ValidationError } from '@/lib/errors/types';
import { requireBook } from './bible-common';

/** Stored field rows read per element (a template has at most a few dozen fields). */
const FIELDS_PER_ELEMENT = 200;
/** Elements whose fields are read in one query. */
const FIELD_READ_BATCH = 200;

function tooLarge(what: 'elements' | 'relations' | 'bytes', max: number): ValidationError {
    return new ValidationError('This bible is too large to export in one file.', { reason: 'EXPORT_TOO_LARGE', what, max });
}

/** The whole bible of a book, as the bundle's data. The caller has asked `bible.view`. */
export async function readBibleBundle(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string): Promise<BibleBundle> {
    const book = await requireBook(db, ctx, bookId);
    const rows = await BibleElementRepository.list(db, ctx.workspaceId, bookId, { take: BUNDLE_MAX_ELEMENTS + 1 });
    if (rows.length > BUNDLE_MAX_ELEMENTS) throw tooLarge('elements', BUNDLE_MAX_ELEMENTS);

    const fieldsById = new Map<string, Map<string, FieldValue>>(rows.map((r) => [r.id, new Map()]));
    const kindById = new Map(rows.map((r) => [r.id, r.kind] as const));
    for (let i = 0; i < rows.length; i += FIELD_READ_BATCH) {
        const ids = rows.slice(i, i + FIELD_READ_BATCH).map((r) => r.id);
        for (const f of await BibleFieldRepository.listForElements(db, ctx.workspaceId, ids, FIELDS_PER_ELEMENT)) {
            const kind = kindById.get(f.elementId);
            if (kind && getFieldDef(kind, f.key)) fieldsById.get(f.elementId)!.set(f.key, decodeFieldValue(f.value));
        }
    }

    const relations = await BibleRelationRepository.listForBook(db, ctx.workspaceId, bookId, BUNDLE_MAX_RELATIONS + 1);
    if (relations.length > BUNDLE_MAX_RELATIONS) throw tooLarge('relations', BUNDLE_MAX_RELATIONS);
    const relationsById = new Map<string, BundleRelation[]>();
    for (const r of relations) {
        relationsById.set(r.fromElementId, [...(relationsById.get(r.fromElementId) ?? []), { type: r.type, to: r.to.slug, note: r.note }]);
    }

    const elements: BundleElement[] = rows.map((r) => ({
        kind: r.kind,
        name: r.name,
        slug: r.slug,
        status: r.status as BibleElementStatus,
        customLabel: r.customLabel,
        summary: r.summary,
        fields: fieldsById.get(r.id)!,
        relations: relationsById.get(r.id) ?? [],
    }));
    return {
        book: {
            title: book.title,
            logline: book.logline,
            genre: book.genre,
            audience: book.audience,
            targetLength: book.targetLength,
            stage: book.stage as BookStage,
        },
        elements,
    };
}

export interface BibleExport {
    fileName: string;
    contentType: string;
    bytes: Uint8Array;
}

/** `<book slug>-bible.<ext>`, ASCII; "book" when the title leaves nothing. */
function fileNameFor(title: string, ext: string): string {
    return `${slugify(title) || 'book'}-bible.${ext}`;
}

export async function exportBibleBundle(ctx: WorkspaceRequestContext, bookId: string): Promise<BibleExport> {
    await assertPermission(ctx, 'bible.view');
    const bundle = await runInWorkspaceContext(ctx, async (db) => {
        const data = await readBibleBundle(db, ctx, bookId);
        await logEvent(
            ctx,
            {
                action: 'BIBLE_EXPORTED',
                entityType: 'Book',
                entityId: bookId,
                details: { format: 'markdown-bundle', elementCount: data.elements.length, relationCount: data.elements.reduce((n, e) => n + e.relations.length, 0) },
            },
            { db },
        );
        return data;
    });
    return { fileName: fileNameFor(bundle.book.title, 'zip'), contentType: 'application/zip', bytes: importableZip(bundleFiles(bundle)) };
}

/**
 * The bundle's files zipped, refused (`EXPORT_TOO_LARGE`, `what: 'bytes'`)
 * unless the import would take the archive: within the upload bound, and
 * read by `readZip` under the import's own limits (each file's and the total
 * inflated size; an entry that would deflate past the ratio is stored by the
 * writer instead). The reader is the oracle, so the two cannot drift apart.
 */
function importableZip(files: ReadonlyMap<string, string>): Uint8Array {
    const bytes = writeZip(files, { maxRatio: BUNDLE_ZIP_LIMITS.maxRatio });
    if (bytes.byteLength > BUNDLE_UPLOAD_MAX_BYTES) throw tooLarge('bytes', BUNDLE_UPLOAD_MAX_BYTES);
    try {
        readZip(bytes, BUNDLE_ZIP_LIMITS);
    } catch (err) {
        if (err instanceof ZipRefusal) throw tooLarge('bytes', BUNDLE_ZIP_LIMITS.maxTotalBytes);
        throw err;
    }
    return bytes;
}

export async function exportBiblePdf(ctx: WorkspaceRequestContext, bookId: string, now: Date = new Date()): Promise<BibleExport> {
    await assertPermission(ctx, 'bible.view');
    const { bundle, workspaceName } = await runInWorkspaceContext(ctx, async (db) => {
        const data = await readBibleBundle(db, ctx, bookId);
        const name = (await WorkspaceRepository.findName(db, ctx.workspaceId)) ?? ctx.workspaceSlug;
        await logEvent(
            ctx,
            {
                action: 'BIBLE_EXPORTED',
                entityType: 'Book',
                entityId: bookId,
                details: { format: 'pdf', elementCount: data.elements.length, relationCount: data.elements.reduce((n, e) => n + e.relations.length, 0) },
            },
            { db },
        );
        return { bundle: data, workspaceName: name };
    });
    const bytes = await renderBiblePdf(bundle, { workspaceName, generatedAt: now.toISOString() });
    return { fileName: fileNameFor(bundle.book.title, 'pdf'), contentType: 'application/pdf', bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}
