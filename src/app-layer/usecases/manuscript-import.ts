/**
 * IMPORTING A MANUSCRIPT (Phase 5.1, D33): a DOCX or a Markdown file becomes
 * parts, chapters and scenes — only once the author has confirmed the split.
 * Two steps, and the file is stored by neither:
 *
 *   preview   `bible.edit`; a missing book is a 404 first. The body is read
 *             bounded by the route (`SOURCE_UPLOAD_MAX_BYTES`, 413 past it),
 *             virus-scanned (`assertUploadClean`), sniffed and read as blocks
 *             by 4.0's reader (`parseSource`: DOCX through mammoth over a ZIP
 *             rebuilt from `readZip`, in the bounded parse worker, an entity
 *             refused; Markdown by its own reader). Anything but DOCX or
 *             Markdown is 400 IMPORT_FORMAT. Answers the outline (every
 *             heading, its level and words), the proposed split and its
 *             counts, the manuscript's own counts, and a token signing the
 *             file's SHA-256 (`import-token.ts`). Nothing is written.
 *   confirm   `bible.edit`; the same file again, with the plan the author
 *             chose in the `x-import-plan` header (levels, scene breaks,
 *             heading overrides, the token). A different file is 409
 *             IMPORT_FILE_CHANGED, an old preview 409 IMPORT_PREVIEW_EXPIRED,
 *             a plan that does not fit the outline 400 IMPORT_PLAN_INVALID.
 *             Then ONE transaction under the structure lock: the bounds
 *             (409 TOO_MANY_*), the parts, chapters and scenes (each scene
 *             with its first version, IMPORT), one audit row. Everything is
 *             refused or written together.
 *
 * IMPORT IS MANUSCRIPT ONLY (D33 item 3): the file is NOT added to the 4.0
 * source library and no fact is drawn from it (5.3 extracts draft facts from
 * scenes as they are saved). Nothing here calls a model.
 *
 * WHERE IT GOES. An import APPENDS: with a part level, its parts follow the
 * manuscript's; without one, its chapters go at the end of the manuscript's
 * last part (an untitled part is made when it has none). Text before the
 * first heading lands in an untitled chapter (and part) of its own.
 *
 * LINEAR. One pass to read the blocks, one to split them (`splitManuscript`,
 * `work` counted), and a constant number of statements a batch of rows; a
 * 150,000-word manuscript imports (5.H times it).
 */
import { randomUUID } from 'node:crypto';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { ManuscriptChapterRepository, ManuscriptPartRepository, ManuscriptRepository, ManuscriptSceneRepository } from '@/app-layer/repositories/manuscript.repository';
import { ImportPlanInput } from '@/app-layer/schemas/manuscript';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { ConflictError, ValidationError } from '@/lib/errors/types';
import { RankExhaustedError } from '@/lib/bible/story-order';
import { parseSource, SourceRefusal, type ParseDeps } from '@/lib/sources/parse';
import type { DocBlock } from '@/lib/sources/document';
import { defaultPlan, outlineOf, planProblem, splitManuscript, type ImportOutline, type ImportPlan, type SplitResult } from '@/lib/manuscript/import-split';
import { fileSha256, signImportToken, verifyImportToken } from '@/lib/manuscript/import-token';
import { sanitiseManuscriptTitle } from '@/lib/manuscript/storage';
import { CHAPTERS_PER_MANUSCRIPT_MAX, IMPORT_HEADINGS_MAX, IMPORT_PLAN_HEADER_MAX, PARTS_PER_MANUSCRIPT_MAX, SCENES_PER_MANUSCRIPT_MAX } from '@/lib/manuscript/vocabulary';
import { assertUploadClean } from './bible-import';
import { requireBook } from './bible-common';
import { appendRanks, byRank, ensureManuscript, lastRank, tooLong } from './manuscript-common';
import { createImportedScenes } from './manuscript-text';

export interface ManuscriptImportDeps extends ParseDeps {
    /** The virus scanner (tests). */
    scan?: Parameters<typeof assertUploadClean>[2]['scan'];
    /** The clock the token is judged by (tests). */
    now?: number;
}

export interface ImportPreviewView {
    format: 'DOCX' | 'MARKDOWN';
    outline: ImportOutline;
    plan: ImportPlan;
    /** What the proposed plan would write. */
    counts: SplitResult['counts'];
    /** What the manuscript holds already (an import appends). */
    existing: { parts: number; chapters: number; scenes: number };
    token: string;
    issuedAt: number;
}

/** The file as blocks, refused by the reader's own reason, or IMPORT_FORMAT when it is neither DOCX nor Markdown. */
async function readBlocks(ctx: WorkspaceRequestContext, upload: { bytes: Uint8Array; filename: string }, deps: ManuscriptImportDeps): Promise<{ format: 'DOCX' | 'MARKDOWN'; blocks: DocBlock[] }> {
    await assertUploadClean(ctx, upload.bytes, { scan: deps.scan }, 'source');
    let parsed: Awaited<ReturnType<typeof parseSource>>;
    try {
        parsed = await parseSource(upload.bytes, upload.filename, deps);
    } catch (err) {
        if (err instanceof SourceRefusal) throw new ValidationError('The file could not be read as a manuscript.', { reason: err.reason, ...(err.detail ? { detail: err.detail } : {}) });
        throw err;
    }
    if (parsed.format !== 'DOCX' && parsed.format !== 'MARKDOWN') throw new ValidationError('Import a Word (.docx) or Markdown file.', { reason: 'IMPORT_FORMAT', format: parsed.format });
    return { format: parsed.format, blocks: parsed.blocks };
}

function checkedOutline(blocks: readonly DocBlock[]): ImportOutline {
    const outline = outlineOf(blocks);
    if (outline.words === 0) throw new ValidationError('The file holds no text.', { reason: 'IMPORT_EMPTY' });
    if (outline.headings.length > IMPORT_HEADINGS_MAX) throw new ValidationError('The file has more headings than one manuscript can hold.', { reason: 'IMPORT_TOO_LARGE', headings: outline.headings.length });
    return outline;
}

async function existingCounts(ctx: WorkspaceRequestContext, bookId: string) {
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        return {
            parts: await ManuscriptPartRepository.count(db, ctx.workspaceId, bookId),
            chapters: await ManuscriptChapterRepository.count(db, ctx.workspaceId, bookId),
            scenes: await ManuscriptSceneRepository.count(db, ctx.workspaceId, bookId),
        };
    });
}

/** The preview (`bible.edit`; the header's rules). Writes nothing. */
export async function previewManuscriptImport(
    ctx: WorkspaceRequestContext,
    bookId: string,
    upload: { bytes: Uint8Array; filename: string },
    deps: ManuscriptImportDeps = {},
): Promise<ImportPreviewView> {
    await assertPermission(ctx, 'bible.edit');
    // A missing or deleted book is a 404 before the file is scanned or read.
    const existing = await existingCounts(ctx, bookId);
    const { format, blocks } = await readBlocks(ctx, upload, deps);
    const outline = checkedOutline(blocks);
    const plan = defaultPlan(outline);
    const issuedAt = deps.now ?? Date.now();
    return {
        format,
        outline,
        plan,
        counts: splitManuscript(blocks, plan).counts,
        existing,
        token: signImportToken({ workspaceId: ctx.workspaceId, userId: ctx.userId, bookId, fileSha256: fileSha256(upload.bytes), issuedAt }),
        issuedAt,
    };
}

/** The plan header: base64url JSON, bounded, strict. */
export function readPlanHeader(value: string | null): ImportPlanInput {
    const invalid = () => new ValidationError('The import plan could not be read.', { reason: 'IMPORT_PLAN_INVALID' });
    if (!value || value.length > IMPORT_PLAN_HEADER_MAX) throw invalid();
    let json: unknown;
    try {
        json = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    } catch {
        throw invalid();
    }
    const parsed = ImportPlanInput.safeParse(json);
    if (!parsed.success) throw invalid();
    return parsed.data;
}

function full(what: 'TOO_MANY_PARTS' | 'TOO_MANY_CHAPTERS' | 'TOO_MANY_SCENES'): never {
    throw new ConflictError('The manuscript cannot hold this import as well as what it holds.', { reason: what });
}

const newId = () => randomUUID().replace(/-/g, '');

function title(raw: string | null): string | null {
    try {
        return sanitiseManuscriptTitle(raw);
    } catch (err) {
        tooLong(err);
    }
}

/** The confirm (`bible.edit`; the header's rules): ONE transaction. */
export async function confirmManuscriptImport(
    ctx: WorkspaceRequestContext,
    bookId: string,
    upload: { bytes: Uint8Array; filename: string },
    planHeader: string | null,
    deps: ManuscriptImportDeps = {},
): Promise<{ parts: number; chapters: number; scenes: number; words: number; firstSceneId: string | null }> {
    await assertPermission(ctx, 'bible.edit');
    // A missing or deleted book is a 404 before the plan, the token or the file is read.
    await existingCounts(ctx, bookId);
    const input = readPlanHeader(planHeader);
    const verdict = verifyImportToken(
        { workspaceId: ctx.workspaceId, userId: ctx.userId, bookId, fileSha256: fileSha256(upload.bytes), issuedAt: input.issuedAt },
        input.token,
        deps.now ?? Date.now(),
    );
    if (verdict === 'BAD_TOKEN') throw new ConflictError('This is not the file you previewed.', { reason: 'IMPORT_FILE_CHANGED' });
    if (verdict === 'EXPIRED') throw new ConflictError('The preview is too old; preview the file again.', { reason: 'IMPORT_PREVIEW_EXPIRED' });
    const { format, blocks } = await readBlocks(ctx, upload, deps);
    const outline = checkedOutline(blocks);
    const plan: ImportPlan = { levels: input.levels, sceneBreaks: input.sceneBreaks, overrides: input.overrides };
    const problem = planProblem(plan, outline);
    if (problem) throw new ValidationError('The split does not fit this file.', { reason: 'IMPORT_PLAN_INVALID', problem });
    const split = splitManuscript(blocks, plan);
    if (split.counts.scenes === 0) throw new ValidationError('The split holds no scene.', { reason: 'IMPORT_EMPTY' });

    return runInWorkspaceContext(
        ctx,
        async (db) => {
            await ManuscriptRepository.lockStructure(db, bookId);
            const manuscript = await ensureManuscript(db, ctx, bookId);
            const parts = byRank(await ManuscriptPartRepository.list(db, ctx.workspaceId, bookId, PARTS_PER_MANUSCRIPT_MAX + 1));
            const chapterCount = await ManuscriptChapterRepository.count(db, ctx.workspaceId, bookId);
            const sceneCount = await ManuscriptSceneRepository.count(db, ctx.workspaceId, bookId);
            // Without a part level the split is one untitled part: its chapters join the manuscript's last part.
            const intoLast = plan.levels.part === null && !plan.overrides.some(([, r]) => r === 'part') && split.parts.length === 1 && split.parts[0].title === null;
            const newParts = intoLast && parts.length > 0 ? 0 : split.parts.length;
            if (parts.length + newParts > PARTS_PER_MANUSCRIPT_MAX) full('TOO_MANY_PARTS');
            if (chapterCount + split.counts.chapters > CHAPTERS_PER_MANUSCRIPT_MAX) full('TOO_MANY_CHAPTERS');
            if (sceneCount + split.counts.scenes > SCENES_PER_MANUSCRIPT_MAX) full('TOO_MANY_SCENES');
            try {
                const partRows: Array<{ id: string; title: string | null; rank: string }> = [];
                const targets: string[] = [];
                if (newParts === 0) {
                    targets.push(parts[parts.length - 1].id);
                } else {
                    const ranks = appendRanks(lastRank(parts), newParts);
                    split.parts.forEach((p, i) => {
                        const id = newId();
                        partRows.push({ id, title: title(p.title), rank: ranks[i] });
                        targets.push(id);
                    });
                }
                await ManuscriptPartRepository.createParts(db, ctx.workspaceId, bookId, manuscript.id, partRows);
                const chapterRows: Array<{ id: string; partId: string; title: string | null; rank: string }> = [];
                const sceneRows: Parameters<typeof createImportedScenes>[3][number][] = [];
                for (let i = 0; i < split.parts.length; i++) {
                    const partId = targets[newParts === 0 ? 0 : i];
                    const after = newParts === 0 ? lastRank(await ManuscriptChapterRepository.listForPart(db, ctx.workspaceId, partId, CHAPTERS_PER_MANUSCRIPT_MAX + 1)) : null;
                    const chapterRanks = appendRanks(after, split.parts[i].chapters.length);
                    split.parts[i].chapters.forEach((c, j) => {
                        const id = newId();
                        chapterRows.push({ id, partId, title: title(c.title), rank: chapterRanks[j] });
                        const sceneRanks = appendRanks(null, c.scenes.length);
                        c.scenes.forEach((s, k) => sceneRows.push({ chapterId: id, rank: sceneRanks[k], title: s.title, paragraphs: s.paragraphs }));
                    });
                }
                await ManuscriptChapterRepository.createChapters(db, ctx.workspaceId, bookId, chapterRows);
                const scenes = await createImportedScenes(db, ctx, bookId, sceneRows);
                await ManuscriptRepository.touch(db, ctx.workspaceId, manuscript.id);
                const counts = { parts: partRows.length, chapters: chapterRows.length, scenes: scenes.ids.length, words: scenes.words };
                await logEvent(ctx, { action: 'MANUSCRIPT_IMPORTED', entityType: 'Manuscript', entityId: manuscript.id, details: { bookId, format, ...counts } }, { db });
                return { ...counts, firstSceneId: scenes.ids[0] ?? null };
            } catch (err) {
                if (err instanceof RankExhaustedError) throw new ConflictError('The manuscript has no room to append there.', { reason: 'ORDER_RANK_EXHAUSTED' });
                throw err;
            }
        },
        { timeout: 120_000 },
    );
}
