/**
 * The full export (Phase 5.H-a, decision D36; roadmap 5.H item 4 and the D33 addendum): EVERYTHING an author has in
 * one archive, protected by a passphrase they choose at download.
 *
 * WHAT. Per live book: its details, its bible as the bundle (byte for byte what the bible export writes), its
 * manuscript as DOCX and Markdown with its outline, and every history and decision as JSON Lines — bible and relation
 * versions, scene, note and card versions, map snapshots, interview sessions, questions and answers, enrichment and
 * research proposals and their decisions, facts and their proposals, threads and their scene links, research briefs,
 * sources and findings, the source library's kept text. Workspace-wide: its series library, its members' roles and
 * names, its audit trail. A README describes every file (`src/lib/export/archive-layout.ts`, one table for the writer
 * and the README) and a manifest counts them.
 *
 * THE PASSPHRASE travels in the POST body only and is judged by `passphraseRefusal` (at least 12 characters; 400
 * with its reason otherwise). It is handed to the archive writer and to nothing else: never stored, logged, traced,
 * audited, put in a job payload or a URL (`tests/integration/privacy-sinks.test.ts` plants one).
 *
 * IN THE REQUEST, STREAMED (the 5.H-a note, "Request or job"). A background job would need the passphrase in its
 * payload, or the archive stored unencrypted until the author came for it; both are refused above. So the archive is
 * written as the response is read: each table a page at a time in a short transaction of its own, each entry
 * compressed and encrypted as it goes (`createEncryptedZip`), the writer waiting on the response (backpressure), so
 * memory holds one page and one book's manuscript, never the workspace. A client that goes away stops it; a failure
 * part-way errors the response (a failed download, never a short archive presented as whole). It holds one of the
 * workspace's stream slots (429 STREAM_CAPACITY past them). Read pages are separate transactions, so an edit made
 * during a long download may land in some files and not others; the manifest names when the export began.
 *
 * WHO. `workspace.export`, OWNER only: the archive is the whole workspace's data. Each book's own bible export stays
 * `bible.view`. One audit row, WORKSPACE_EXPORTED, as the export starts (counts only).
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BookExportReaders, ExportRepository, SeriesExportReaders, toExportJson, type BookExportTable } from '@/app-layer/repositories/export.repository';
import { ManuscriptSceneRepository, type SceneRow } from '@/app-layer/repositories/manuscript.repository';
import { WorkspaceExportRequest } from '@/app-layer/schemas/your-data';
import { slugify } from '@/lib/bible/slug';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { RateLimitedError, ValidationError } from '@/lib/errors/types';
import { BOOK_FILES, BOOK_TABLE_FILES, EXPORT_FORMAT, EXPORT_FORMAT_VERSION, NOT_INCLUDED, ROOT_FILES } from '@/lib/export/archive-layout';
import { createEncryptedZip, type EncryptedZip } from '@/lib/export/encrypted-zip';
import { manuscriptDocx, manuscriptMarkdown, type ExportManuscript } from '@/lib/export/manuscript-files';
import { passphraseRefusal } from '@/lib/export/passphrase';
import { acquireStreamSlot } from '@/lib/http/stream-capacity';
import { sceneBlocks } from '@/lib/manuscript/scene-blocks';
import { logger } from '@/lib/observability/logger';
import { safeErrorMeta } from '@/lib/observability/safe-error';
import { bibleBundleBytesInTx } from './bible-export';
import { readOutlineRows, byRank } from './manuscript-common';

/** Books one archive holds at most; past it the export is refused (a workspace that large is exported by support). */
export const EXPORT_BOOKS_MAX = 500;
/** Members, cards and links read at most (far above what a workspace holds). */
const EXPORT_LIST_MAX = 10_000;
/** Scenes whose text is read in one transaction while a manuscript is assembled. */
const SCENE_TEXT_BATCH = 100;
/** Audit rows a page. */
const AUDIT_PAGE = 500;

export interface WorkspaceExportStream {
    fileName: string;
    stream: ReadableStream<Uint8Array>;
}

const encoder = new TextEncoder();

/**
 * A JSON Lines entry read a page at a time as the archive pulls it: each page in a transaction of its own, each row
 * one line. `counts` is told the number of rows when the file ends.
 */
function jsonlStream(read: (afterId: string | null) => Promise<Array<{ id: string }>>, pageSize: number, onDone: (rows: number) => void): ReadableStream<Uint8Array> {
    let after: string | null = null;
    let rows = 0;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const page = await read(after);
            if (page.length > 0) {
                after = page[page.length - 1].id;
                rows += page.length;
                controller.enqueue(encoder.encode(page.map((r) => JSON.stringify(toExportJson(r))).join('\n') + '\n'));
            }
            if (page.length < pageSize) {
                onDone(rows);
                controller.close();
            }
        },
    });
}

/** Start the export (`workspace.export`): checks, the audit row, then the archive's stream, written as it is read. */
export async function startWorkspaceExport(ctx: WorkspaceRequestContext, input: unknown, now: Date = new Date()): Promise<WorkspaceExportStream> {
    await assertPermission(ctx, 'workspace.export');
    const { passphrase } = WorkspaceExportRequest.parse(input);
    const refusal = passphraseRefusal(passphrase);
    if (refusal) throw new ValidationError('Choose a longer passphrase.', { reason: refusal });

    const lease = acquireStreamSlot(ctx.workspaceId);
    if (typeof lease === 'string') throw new RateLimitedError('Too many downloads are running.', { reason: 'STREAM_CAPACITY', bound: lease });
    try {
        const head = await runInWorkspaceContext(ctx, async (db) => {
            const workspace = await ExportRepository.workspace(db, ctx.workspaceId);
            const books = await ExportRepository.books(db, ctx.workspaceId, EXPORT_BOOKS_MAX + 1);
            if (books.length > EXPORT_BOOKS_MAX) throw new ValidationError('This workspace holds too many books for one archive.', { reason: 'EXPORT_TOO_MANY_BOOKS', max: EXPORT_BOOKS_MAX });
            await logEvent(ctx, { action: 'WORKSPACE_EXPORTED', entityType: 'Workspace', entityId: ctx.workspaceId, details: { bookCount: books.length, formatVersion: EXPORT_FORMAT_VERSION } }, { db });
            return { workspace, books };
        });
        const zip = createEncryptedZip(passphrase);
        void writeArchive(ctx, zip, head, now)
            .catch(async (err) => {
                const meta = safeErrorMeta(err);
                if (meta.code !== 'EXPORT_CANCELLED') logger.error('workspace export failed part-way', { component: 'workspace-export', workspaceId: ctx.workspaceId, code: meta.code ?? meta.name });
                await zip.abort(err);
            })
            .finally(() => lease.release());
        const day = now.toISOString().slice(0, 10);
        return { fileName: `${slugify(head.workspace?.name ?? '') || 'workspace'}-inkquisitor-export-${day}.zip`, stream: zip.readable };
    } catch (err) {
        lease.release();
        throw err;
    }
}

type Head = { workspace: Awaited<ReturnType<typeof ExportRepository.workspace>>; books: Awaited<ReturnType<typeof ExportRepository.books>> };

async function writeArchive(ctx: WorkspaceRequestContext, zip: EncryptedZip, head: Head, now: Date): Promise<void> {
    const inTx = <T>(fn: (db: PrismaTx) => Promise<T>) => runInWorkspaceContext(ctx, fn);
    const counts: Record<string, number> = {};
    const notes: string[] = [];
    const folders: Array<{ folder: string; title: string; bundle: boolean }> = [];

    const members = await inTx((db) => ExportRepository.members(db, ctx.workspaceId, EXPORT_LIST_MAX));
    await zip.addText(ROOT_FILES.workspace.path, `${JSON.stringify(toExportJson({ ...head.workspace, members }), null, 2)}\n`);
    counts[ROOT_FILES.workspace.path] = 1;

    for (const [i, book] of head.books.entries()) {
        const folder = `books/${String(i + 1).padStart(3, '0')}-${slugify(book.title) || 'book'}/`;
        await zip.addText(folder + BOOK_FILES.book.path, `${JSON.stringify(toExportJson(book), null, 2)}\n`);
        counts[folder + BOOK_FILES.book.path] = 1;

        const bundle = await inTx((db) => bibleBundleBytesInTx(db, ctx, book.id));
        if (bundle === 'TOO_LARGE') notes.push(`${folder}${BOOK_FILES.bundle.path} is not included: the bible is larger than the bundle format holds. Its whole state is in ${folder}${BOOK_TABLE_FILES[0].path} (each entry’s newest version).`);
        else {
            // Stored, not deflated again: the bundle is a zip already, and its bytes are the bible export's own.
            await zip.addBytes(folder + BOOK_FILES.bundle.path, bundle.bytes, { store: true });
            counts[folder + BOOK_FILES.bundle.path] = 1;
        }

        const manuscript = await readManuscript(ctx, book.id, book.title);
        await zip.addBytes(folder + BOOK_FILES.docx.path, manuscriptDocx(manuscript.files), { store: true });
        await zip.addText(folder + BOOK_FILES.markdown.path, manuscriptMarkdown(manuscript.files));
        await zip.addText(folder + BOOK_FILES.outline.path, `${JSON.stringify(manuscript.outline, null, 2)}\n`);
        counts[folder + BOOK_FILES.docx.path] = manuscript.sceneCount;
        counts[folder + BOOK_FILES.markdown.path] = manuscript.sceneCount;
        counts[folder + BOOK_FILES.outline.path] = manuscript.sceneCount;

        for (const file of BOOK_TABLE_FILES) {
            const read = BookExportReaders[file.table as BookExportTable] as (db: PrismaTx, workspaceId: string, bookId: string, after: string | null, take: number) => Promise<Array<{ id: string }>>;
            await zip.addStream(
                folder + file.path,
                jsonlStream((afterId) => inTx((db) => read(db, ctx.workspaceId, book.id, afterId, file.page)), file.page, (rows) => (counts[folder + file.path] = rows)),
            );
        }
        folders.push({ folder, title: book.title, bundle: bundle !== 'TOO_LARGE' });
    }

    const series: Array<[string, (db: PrismaTx, ws: string, a: string | null, take: number) => Promise<Array<{ id: string }>>]> = [
        [ROOT_FILES.seriesSources.path, SeriesExportReaders.sources],
        [ROOT_FILES.seriesChunks.path, SeriesExportReaders.sourceChunks],
        [ROOT_FILES.seriesFacts.path, SeriesExportReaders.facts],
    ];
    for (const [path, read] of series) {
        await zip.addStream(path, jsonlStream((afterId) => inTx((db) => read(db, ctx.workspaceId, afterId, 200)), 200, (rows) => (counts[path] = rows)));
    }
    await zip.addStream(
        ROOT_FILES.audit.path,
        jsonlStream((afterId) => inTx((db) => ExportRepository.auditPage(db, ctx.workspaceId, afterId, AUDIT_PAGE)), AUDIT_PAGE, (rows) => (counts[ROOT_FILES.audit.path] = rows)),
    );

    const manifest = {
        format: EXPORT_FORMAT,
        formatVersion: EXPORT_FORMAT_VERSION,
        exportedAt: now.toISOString(),
        workspace: head.workspace?.name ?? null,
        books: folders.map((f) => ({ folder: f.folder, title: f.title, bibleBundle: f.bundle })),
        files: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        notes,
    };
    await zip.addText(ROOT_FILES.manifest.path, `${JSON.stringify(manifest, null, 2)}\n`);
    await zip.addText(ROOT_FILES.readme.path, readme(head.workspace?.name ?? '', now, folders, notes));
    await zip.close();
}

/** The book's manuscript, assembled in manuscript order: the files' data and the outline's JSON. */
async function readManuscript(ctx: WorkspaceRequestContext, bookId: string, bookTitle: string): Promise<{ files: ExportManuscript; outline: unknown; sceneCount: number }> {
    const { rows, cards, links } = await runInWorkspaceContext(ctx, async (db) => ({
        rows: await readOutlineRows(db, ctx, bookId),
        cards: await ExportRepository.sceneCards(db, ctx.workspaceId, bookId, EXPORT_LIST_MAX),
        links: await ExportRepository.sceneLinks(db, ctx.workspaceId, bookId, EXPORT_LIST_MAX),
    }));
    const full = new Map<string, SceneRow>();
    const ids = rows.scenes.map((s) => s.id);
    for (let i = 0; i < ids.length; i += SCENE_TEXT_BATCH) {
        const batch = ids.slice(i, i + SCENE_TEXT_BATCH);
        for (const s of await runInWorkspaceContext(ctx, (db) => ManuscriptSceneRepository.findFull(db, ctx.workspaceId, bookId, batch))) full.set(s.id, s);
    }
    const cardOf = new Map(cards.map((c) => [c.sceneId, c] as const));
    const parts = byRank(rows.parts).map((p) => ({
        id: p.id,
        title: p.title,
        chapters: byRank(rows.chapters.filter((c) => c.partId === p.id)).map((c) => ({
            id: c.id,
            title: c.title,
            scenes: byRank(rows.scenes.filter((s) => s.chapterId === c.id && full.has(s.id))).map((s) => full.get(s.id)!),
        })),
    }));
    const singleDefaultPart = parts.length === 1 && parts[0].title === null;
    const files: ExportManuscript = {
        bookTitle,
        singleDefaultPart,
        parts: parts.map((p) => ({ title: p.title, chapters: p.chapters.map((c) => ({ title: c.title, scenes: c.scenes.map((s) => ({ title: s.title, blocks: sceneBlocks(s.text) })) })) })),
    };
    const outline = {
        bookTitle,
        parts: parts.map((p) => ({
            id: p.id,
            title: p.title,
            chapters: p.chapters.map((c) => ({
                id: c.id,
                title: c.title,
                scenes: c.scenes.map((s) => ({
                    id: s.id,
                    title: s.title,
                    wordCount: s.wordCount,
                    povElementId: s.povElementId,
                    settingElementId: s.settingElementId,
                    storyTime: s.storyTime,
                    note: s.note,
                    card: cardOf.get(s.id) ?? null,
                    elementLinks: links.elements.filter((l) => l.sceneId === s.id).map((l) => ({ elementId: l.elementId, mentioned: l.mentioned, explicit: l.explicit })),
                    beatElementIds: links.beats.filter((l) => l.sceneId === s.id).map((l) => l.beatElementId),
                })),
            })),
        })),
    };
    return { files, outline: toExportJson(outline), sceneCount: full.size };
}

function readme(workspaceName: string, now: Date, folders: ReadonlyArray<{ folder: string; title: string }>, notes: readonly string[]): string {
    const line = (path: string, describe: string) => `- \`${path}\` — ${describe}`;
    const out: string[] = [
        `# Your Inkquisitor export`,
        '',
        `Workspace: ${workspaceName.replace(/[\r\n]+/g, ' ')}`,
        `Made: ${now.toISOString()} (format ${EXPORT_FORMAT} version ${EXPORT_FORMAT_VERSION})`,
        '',
        'This archive is everything your workspace holds: each book’s bible, manuscript, interviews and every version and decision, your sources and research, and the workspace’s audit trail. It is encrypted with AES-256 and the passphrase you chose; Inkquisitor does not keep the passphrase and cannot recover it. Any zip tool that reads AES-encrypted archives opens it (7-Zip, WinZip, Keka or The Unarchiver on a Mac, `bsdtar`).',
        '',
        'JSON Lines files (`.jsonl`) hold one record a line, every column of it. Dates are in UTC, as ISO strings. Ids join the files: an answer names its question, a version names the answers it came from.',
        '',
        '## At the top',
        '',
        line(ROOT_FILES.readme.path, ROOT_FILES.readme.describe),
        line(ROOT_FILES.manifest.path, ROOT_FILES.manifest.describe),
        line(ROOT_FILES.workspace.path, ROOT_FILES.workspace.describe),
        line(ROOT_FILES.audit.path, ROOT_FILES.audit.describe),
        line(ROOT_FILES.seriesSources.path, ROOT_FILES.seriesSources.describe),
        line(ROOT_FILES.seriesChunks.path, ROOT_FILES.seriesChunks.describe),
        line(ROOT_FILES.seriesFacts.path, ROOT_FILES.seriesFacts.describe),
        '',
        '## In each book’s folder',
        '',
        ...folders.map((f) => `- \`${f.folder}\` — ${f.title.replace(/[\r\n]+/g, ' ')}`),
        '',
        ...Object.values(BOOK_FILES).map((f) => line(f.path, f.describe)),
        ...BOOK_TABLE_FILES.map((f) => line(f.path, f.describe)),
        '',
        '## Not in this archive',
        '',
        ...NOT_INCLUDED.map((n) => `- ${n}`),
        ...(notes.length > 0 ? ['', '## Notes on this archive', '', ...notes.map((n) => `- ${n}`)] : []),
        '',
    ];
    return out.join('\n');
}
