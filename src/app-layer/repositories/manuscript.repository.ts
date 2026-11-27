/**
 * The manuscript's tables (Phase 5.1, D33). Workspace-scoped: every query runs
 * inside `runInWorkspaceContext` AND filters by `workspaceId`, and every query
 * by its book. No authorization and no validation here: the usecases
 * (`src/app-layer/usecases/manuscript*.ts`) ask permission and sanitise first.
 *
 * The encrypted columns (titles, `text`, `storyTime`, `note`, the versions'
 * `text` and `note`) are sealed and opened by the field-encryption extension;
 * this module reads and writes plaintext and never filters on them. Outline
 * reads carry no scene text: a manuscript of five thousand scenes decrypts
 * their titles, never their prose.
 *
 * A SCENE'S TEXT IS WRITTEN BY TWO METHODS ONLY, `setText` and `createScenes`,
 * and only `src/app-layer/usecases/manuscript-text.ts` calls them (D3,
 * `tests/guards/scene-text-stays-off-the-model-path.test.ts`).
 */
import type { BibleVersionSource, Prisma, PrismaClient, SceneVersionSource } from '@prisma/client';

type Db = Prisma.TransactionClient;

/**
 * A LIVE scene (Phase 5.H-a, issue #71): every read and write of a scene below asks it, so a deleted scene is hidden
 * from the outline, the editor, its board cards, its mentions, the research fit and every save, and is reached only
 * by the Recently deleted list, its restore and the purge.
 */
const LIVE = { deletedAt: null } as const satisfies Prisma.ManuscriptSceneWhereInput;
/** A row of a LIVE scene (a link, a card, a proposal: reached through its `scene` relation). */
export const OF_LIVE_SCENE = { scene: LIVE } as const;

const PART_SELECT = { id: true, manuscriptId: true, title: true, rank: true, updatedAt: true } as const satisfies Prisma.ManuscriptPartSelect;
const CHAPTER_SELECT = { id: true, partId: true, title: true, rank: true, updatedAt: true } as const satisfies Prisma.ManuscriptChapterSelect;
/** A scene as the outline shows it: no text, no note. */
export const SCENE_OUTLINE_SELECT = {
    id: true,
    chapterId: true,
    title: true,
    rank: true,
    wordCount: true,
    povElementId: true,
    settingElementId: true,
    updatedAt: true,
} as const satisfies Prisma.ManuscriptSceneSelect;
export const SCENE_SELECT = {
    ...SCENE_OUTLINE_SELECT,
    bookId: true,
    text: true,
    revision: true,
    storyTime: true,
    note: true,
    noteVersion: true,
    createdAt: true,
} as const satisfies Prisma.ManuscriptSceneSelect;
const SCENE_HEAD_SELECT = {
    id: true,
    bookId: true,
    chapterId: true,
    rank: true,
    revision: true,
    povElementId: true,
    settingElementId: true,
    noteVersion: true,
    wordCount: true,
} as const satisfies Prisma.ManuscriptSceneSelect;
const VERSION_META_SELECT = { id: true, sceneId: true, versionNumber: true, wordCount: true, source: true, restoredFromVersion: true, authorId: true, createdAt: true } as const satisfies Prisma.SceneVersionSelect;

export type PartRow = Prisma.ManuscriptPartGetPayload<{ select: typeof PART_SELECT }>;
export type ChapterRow = Prisma.ManuscriptChapterGetPayload<{ select: typeof CHAPTER_SELECT }>;
export type SceneOutlineRow = Prisma.ManuscriptSceneGetPayload<{ select: typeof SCENE_OUTLINE_SELECT }>;
export type SceneRow = Prisma.ManuscriptSceneGetPayload<{ select: typeof SCENE_SELECT }>;
export type SceneHeadRow = Prisma.ManuscriptSceneGetPayload<{ select: typeof SCENE_HEAD_SELECT }>;
export type SceneVersionMetaRow = Prisma.SceneVersionGetPayload<{ select: typeof VERSION_META_SELECT }>;

export const ManuscriptRepository = {
    async find(db: Db, workspaceId: string, bookId: string) {
        return db.manuscript.findFirst({ where: { workspaceId, bookId }, select: { id: true, bookId: true } });
    },

    async create(db: Db, workspaceId: string, bookId: string) {
        return db.manuscript.create({ data: { workspaceId, bookId }, select: { id: true, bookId: true } });
    },

    async touch(db: Db, workspaceId: string, manuscriptId: string) {
        await db.manuscript.updateMany({ where: { workspaceId, id: manuscriptId }, data: { updatedAt: new Date() } });
    },

    /**
     * The manuscript's STRUCTURE lock (a transaction-scoped advisory lock on
     * the book): every create, move and delete of a part, chapter or scene, and
     * an import, take it, so ranks and counts are read and written in turn.
     * LOCK ORDER (D25, extended by 5.1): after every bible lock — map → names →
     * order → element → relation → manuscript → scene — and BEFORE any scene's
     * own lock. No path takes a bible advisory lock after it.
     */
    async lockStructure(db: Db, bookId: string) {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'manuscript:' + bookId}))`;
    },

    /** One scene's lock: every save of its text, metadata or note, and a restore, queue here. Taken after `lockStructure` when both are. */
    async lockScene(db: Db, sceneId: string) {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'manuscript-scene:' + sceneId}))`;
    },

    /**
     * The scene's ROW, held FOR NO KEY UPDATE to commit: taken by every save
     * that writes the scene's links (its text, its details, a restore) AFTER the
     * elements it names (`lockElements`) and BEFORE any link row. A deletion of
     * the scene's part or chapter takes the scene row by cascade and then its
     * links; a save that wrote a link first and waited for the scene row
     * would deadlock with it (40P01). False when the scene is gone or deleted (5.H-a).
     */
    async lockSceneRow(db: Db, workspaceId: string, sceneId: string): Promise<boolean> {
        const rows = await db.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "ManuscriptScene" WHERE "workspaceId" = ${workspaceId} AND "id" = ${sceneId} AND "deletedAt" IS NULL FOR NO KEY UPDATE`;
        return rows.length > 0;
    },

    /**
     * The bible elements of the book among `ids`, each row held FOR KEY SHARE
     * to commit (a deletion of one waits for this save, or this save for it).
     * Taken BEFORE the save touches any link or scene row: a bible deletion
     * locks its element row and then, by cascade, the scene rows naming it, so
     * a save that held a scene row while it waited for an element row would
     * deadlock with it (D25: element rows before scene rows, whoever writes).
     * No advisory bible lock is taken.
     */
    async lockElements(db: Db, workspaceId: string, bookId: string, ids: readonly string[]): Promise<Map<string, { kind: string; name: string }>> {
        if (ids.length === 0) return new Map();
        const rows = await db.$queryRaw<Array<{ id: string; kind: string; name: string }>>`
            SELECT "id", "kind"::text AS "kind", "name" FROM "BibleElement"
            WHERE "workspaceId" = ${workspaceId} AND "bookId" = ${bookId} AND "id" = ANY(${[...ids]}::text[])
            ORDER BY "id"
            FOR KEY SHARE`;
        return new Map(rows.map((r) => [r.id, { kind: r.kind, name: r.name }]));
    },

    /** Bible elements of the book by id, with their summaries (the editor's side panel), at most `ids.length`. Read only. */
    async elementsByIds(db: Db, workspaceId: string, bookId: string, ids: readonly string[]) {
        if (ids.length === 0) return [];
        return db.bibleElement.findMany({ where: { workspaceId, bookId, id: { in: [...ids] } }, select: { id: true, kind: true, name: true, summary: true }, take: ids.length });
    },

    /** The database's clock (a version's age is judged by one clock, whatever app server saves). */
    async dbNow(db: Db): Promise<Date> {
        const rows = await db.$queryRaw<Array<{ now: Date }>>`SELECT now() AS "now"`;
        return rows[0].now;
    },
};

/** The three ranked levels of the manuscript (a rebalance names one). */
export type RankedLevel = 'part' | 'chapter' | 'scene';

/**
 * REBALANCE one parent's ranks (Phase 5.1 review): `ids` (every row of the
 * parent, in their order) take `ranks`. In two passes, because the unique
 * `(parent, rank)` is checked row by row inside a statement: first every row
 * takes a TEMPORARY rank the caller chose clear of every old and new rank, then
 * its final one — so no row ever lands on a rank another still holds. The
 * caller holds the manuscript's structure lock. A constant number of
 * statements a thousand rows.
 */
async function rebalanceRanks(db: Db, workspaceId: string, level: RankedLevel, ids: readonly string[], temporary: readonly string[], ranks: readonly string[]): Promise<number> {
    if (ids.length !== ranks.length || ids.length !== temporary.length) throw new RangeError('rebalanceRanks: ids and ranks differ in length');
    let written = 0;
    for (const pass of [temporary, ranks]) {
        written = 0;
        for (let i = 0; i < ids.length; i += 1_000) {
            const batch = [...ids.slice(i, i + 1_000)];
            const values = [...pass.slice(i, i + 1_000)];
            if (level === 'part') {
                written += await db.$executeRaw`UPDATE "ManuscriptPart" AS t SET "rank" = v."rank" FROM unnest(${batch}::text[], ${values}::text[]) AS v("id", "rank") WHERE t."id" = v."id" AND t."workspaceId" = ${workspaceId}`;
            } else if (level === 'chapter') {
                written += await db.$executeRaw`UPDATE "ManuscriptChapter" AS t SET "rank" = v."rank" FROM unnest(${batch}::text[], ${values}::text[]) AS v("id", "rank") WHERE t."id" = v."id" AND t."workspaceId" = ${workspaceId}`;
            } else {
                written += await db.$executeRaw`UPDATE "ManuscriptScene" AS t SET "rank" = v."rank" FROM unnest(${batch}::text[], ${values}::text[]) AS v("id", "rank") WHERE t."id" = v."id" AND t."workspaceId" = ${workspaceId}`;
            }
        }
    }
    return written;
}

export const ManuscriptOrderRepository = { rebalanceRanks };

export const ManuscriptPartRepository = {
    async list(db: Db, workspaceId: string, bookId: string, take: number): Promise<PartRow[]> {
        return db.manuscriptPart.findMany({ where: { workspaceId, bookId }, select: PART_SELECT, take });
    },

    async find(db: Db, workspaceId: string, bookId: string, partId: string): Promise<PartRow | null> {
        return db.manuscriptPart.findFirst({ where: { workspaceId, bookId, id: partId }, select: PART_SELECT });
    },

    async count(db: Db, workspaceId: string, bookId: string): Promise<number> {
        return db.manuscriptPart.count({ where: { workspaceId, bookId } });
    },

    async create(db: Db, workspaceId: string, data: { bookId: string; manuscriptId: string; title: string | null; rank: string }): Promise<PartRow> {
        return db.manuscriptPart.create({ data: { workspaceId, bookId: data.bookId, manuscriptId: data.manuscriptId, title: data.title, rank: data.rank }, select: PART_SELECT });
    },

    /** An import's parts, one statement (ids minted by the caller so chapters can name them). */
    async createParts(db: Db, workspaceId: string, bookId: string, manuscriptId: string, rows: ReadonlyArray<{ id: string; title: string | null; rank: string }>) {
        if (rows.length === 0) return;
        await db.manuscriptPart.createMany({ data: rows.map((r) => ({ id: r.id, workspaceId, bookId, manuscriptId, title: r.title, rank: r.rank })) });
    },

    async rename(db: Db, workspaceId: string, partId: string, title: string | null) {
        return db.manuscriptPart.updateMany({ where: { workspaceId, id: partId }, data: { title } });
    },

    async setRank(db: Db, workspaceId: string, partId: string, rank: string) {
        return db.manuscriptPart.updateMany({ where: { workspaceId, id: partId }, data: { rank } });
    },

    async remove(db: Db, workspaceId: string, bookId: string, partId: string): Promise<number> {
        return (await db.manuscriptPart.deleteMany({ where: { workspaceId, bookId, id: partId } })).count;
    },
};

export const ManuscriptChapterRepository = {
    async list(db: Db, workspaceId: string, bookId: string, take: number): Promise<ChapterRow[]> {
        return db.manuscriptChapter.findMany({ where: { workspaceId, bookId }, select: CHAPTER_SELECT, take });
    },

    async listForPart(db: Db, workspaceId: string, partId: string, take: number): Promise<ChapterRow[]> {
        return db.manuscriptChapter.findMany({ where: { workspaceId, partId }, select: CHAPTER_SELECT, take });
    },

    async find(db: Db, workspaceId: string, bookId: string, chapterId: string): Promise<ChapterRow | null> {
        return db.manuscriptChapter.findFirst({ where: { workspaceId, bookId, id: chapterId }, select: CHAPTER_SELECT });
    },

    async findByIds(db: Db, workspaceId: string, bookId: string, ids: readonly string[]): Promise<ChapterRow[]> {
        if (ids.length === 0) return [];
        return db.manuscriptChapter.findMany({ where: { workspaceId, bookId, id: { in: [...ids] } }, select: CHAPTER_SELECT, take: ids.length });
    },

    async count(db: Db, workspaceId: string, bookId: string): Promise<number> {
        return db.manuscriptChapter.count({ where: { workspaceId, bookId } });
    },

    async create(db: Db, workspaceId: string, data: { bookId: string; partId: string; title: string | null; rank: string }): Promise<ChapterRow> {
        return db.manuscriptChapter.create({ data: { workspaceId, bookId: data.bookId, partId: data.partId, title: data.title, rank: data.rank }, select: CHAPTER_SELECT });
    },

    /** An import's chapters, in batches of a thousand a statement (ids minted by the caller so scenes can name them). */
    async createChapters(db: Db, workspaceId: string, bookId: string, rows: ReadonlyArray<{ id: string; partId: string; title: string | null; rank: string }>) {
        for (let i = 0; i < rows.length; i += 1_000) {
            await db.manuscriptChapter.createMany({ data: rows.slice(i, i + 1_000).map((r) => ({ id: r.id, workspaceId, bookId, partId: r.partId, title: r.title, rank: r.rank })) });
        }
    },

    async rename(db: Db, workspaceId: string, chapterId: string, title: string | null) {
        return db.manuscriptChapter.updateMany({ where: { workspaceId, id: chapterId }, data: { title } });
    },

    async move(db: Db, workspaceId: string, chapterId: string, to: { partId: string; rank: string }) {
        return db.manuscriptChapter.updateMany({ where: { workspaceId, id: chapterId }, data: { partId: to.partId, rank: to.rank } });
    },

    async remove(db: Db, workspaceId: string, bookId: string, chapterId: string): Promise<number> {
        return (await db.manuscriptChapter.deleteMany({ where: { workspaceId, bookId, id: chapterId } })).count;
    },
};

/** One imported scene: its chapter, title, place and text (already sanitised by the one text writer). */
export interface SceneInsert {
    id: string;
    chapterId: string;
    title: string | null;
    rank: string;
    text: string;
    wordCount: number;
}

export const ManuscriptSceneRepository = {
    async listOutline(db: Db, workspaceId: string, bookId: string, take: number): Promise<SceneOutlineRow[]> {
        return db.manuscriptScene.findMany({ where: { workspaceId, bookId, ...LIVE }, select: SCENE_OUTLINE_SELECT, take });
    },

    async listForChapter(db: Db, workspaceId: string, chapterId: string, take: number): Promise<SceneOutlineRow[]> {
        return db.manuscriptScene.findMany({ where: { workspaceId, chapterId, ...LIVE }, select: SCENE_OUTLINE_SELECT, take });
    },

    async listForChapters(db: Db, workspaceId: string, bookId: string, chapterIds: readonly string[], take: number): Promise<SceneOutlineRow[]> {
        if (chapterIds.length === 0) return [];
        return db.manuscriptScene.findMany({ where: { workspaceId, bookId, chapterId: { in: [...chapterIds] }, ...LIVE }, select: SCENE_OUTLINE_SELECT, take });
    },

    async findOutline(db: Db, workspaceId: string, bookId: string, ids: readonly string[]): Promise<SceneOutlineRow[]> {
        if (ids.length === 0) return [];
        return db.manuscriptScene.findMany({ where: { workspaceId, bookId, id: { in: [...ids] }, ...LIVE }, select: SCENE_OUTLINE_SELECT, take: ids.length });
    },

    async find(db: Db, workspaceId: string, bookId: string, sceneId: string): Promise<SceneRow | null> {
        return db.manuscriptScene.findFirst({ where: { workspaceId, bookId, id: sceneId, ...LIVE }, select: SCENE_SELECT });
    },

    /** Several scenes with their text and note (the research fit's excerpts), at most `ids.length`. */
    async findFull(db: Db, workspaceId: string, bookId: string, ids: readonly string[]): Promise<SceneRow[]> {
        if (ids.length === 0) return [];
        return db.manuscriptScene.findMany({ where: { workspaceId, bookId, id: { in: [...ids] }, ...LIVE }, select: SCENE_SELECT, take: ids.length });
    },

    async head(db: Db, workspaceId: string, bookId: string, sceneId: string): Promise<SceneHeadRow | null> {
        return db.manuscriptScene.findFirst({ where: { workspaceId, bookId, id: sceneId, ...LIVE }, select: SCENE_HEAD_SELECT });
    },

    /**
     * Every scene's title, text and note of a book, for the research egress index (bounded by the caller). A DELETED
     * scene is read too (5.H-a): its words are still the author's until the purge, and the brief's quote check is
     * stricter for holding them.
     */
    async listTextForIndex(db: Db, workspaceId: string, bookId: string, take: number) {
        return db.manuscriptScene.findMany({ where: { workspaceId, bookId }, select: { id: true, title: true, text: true, note: true, storyTime: true }, take });
    },

    async count(db: Db, workspaceId: string, bookId: string): Promise<number> {
        return db.manuscriptScene.count({ where: { workspaceId, bookId, ...LIVE } });
    },

    /**
     * Word search over scenes (Phase 5.H-a, D33 addendum A): a book's LIVE scenes sized by STORED bytes of their
     * title, text and note (nothing decrypted), in id order, at most `take`, so the search reads them a bounded chunk at a
     * time (`textsForSearch`).
     */
    async storedBytesForSearch(db: Db, workspaceId: string, bookId: string, take: number): Promise<Array<{ id: string; chapterId: string; bytes: number }>> {
        return db.$queryRaw<Array<{ id: string; chapterId: string; bytes: number }>>`
            SELECT "id", "chapterId",
                   (octet_length("text") + COALESCE(octet_length("title"), 0) + COALESCE(octet_length("note"), 0))::int AS "bytes"
            FROM "ManuscriptScene"
            WHERE "workspaceId" = ${workspaceId} AND "bookId" = ${bookId} AND "deletedAt" IS NULL
            ORDER BY "id"
            LIMIT ${take}`;
    },

    /** These live scenes' title, text and note (decrypted by the extension), at most `ids.length`: one chunk of a search. */
    async textsForSearch(db: Db, workspaceId: string, bookId: string, ids: readonly string[]) {
        if (ids.length === 0) return [];
        return db.manuscriptScene.findMany({ where: { workspaceId, bookId, id: { in: [...ids] }, ...LIVE }, select: { id: true, title: true, text: true, note: true }, take: ids.length });
    },

    /** Words per chapter, an aggregate. */
    async wordsByChapter(db: Db, workspaceId: string, bookId: string) {
        const rows = await db.manuscriptScene.groupBy({ by: ['chapterId'], where: { workspaceId, bookId, ...LIVE }, _sum: { wordCount: true } });
        return new Map(rows.map((r) => [r.chapterId, r._sum.wordCount ?? 0]));
    },

    /** A new, empty scene. */
    async create(db: Db, workspaceId: string, data: { bookId: string; chapterId: string; title: string | null; rank: string }): Promise<SceneOutlineRow> {
        return db.manuscriptScene.create({ data: { workspaceId, bookId: data.bookId, chapterId: data.chapterId, title: data.title, rank: data.rank }, select: SCENE_OUTLINE_SELECT });
    },

    /** THE TEXT WRITER, one scene: its sanitised text, its word count and the next revision. Called only by `manuscript-text.ts`. */
    async setText(db: Db, workspaceId: string, sceneId: string, data: { text: string; wordCount: number; revision: number }) {
        return db.manuscriptScene.updateMany({ where: { workspaceId, id: sceneId, ...LIVE }, data: { text: data.text, wordCount: data.wordCount, revision: data.revision } });
    },

    /** THE TEXT WRITER, an import's scenes in one statement each batch. Called only by `manuscript-text.ts`. */
    async createScenes(db: Db, workspaceId: string, bookId: string, scenes: readonly SceneInsert[]) {
        return db.manuscriptScene.createMany({
            data: scenes.map((s) => ({ id: s.id, workspaceId, bookId, chapterId: s.chapterId, title: s.title, rank: s.rank, text: s.text, wordCount: s.wordCount })),
        });
    },

    async updateMeta(
        db: Db,
        workspaceId: string,
        sceneId: string,
        data: { title: string | null; povElementId: string | null; settingElementId: string | null; storyTime: string | null; revision: number },
    ) {
        return db.manuscriptScene.updateMany({
            where: { workspaceId, id: sceneId, ...LIVE },
            data: { title: data.title, povElementId: data.povElementId, settingElementId: data.settingElementId, storyTime: data.storyTime, revision: data.revision },
        });
    },

    async setNote(db: Db, workspaceId: string, sceneId: string, data: { note: string | null; noteVersion: number }) {
        return db.manuscriptScene.updateMany({ where: { workspaceId, id: sceneId, ...LIVE }, data: { note: data.note, noteVersion: data.noteVersion } });
    },

    async move(db: Db, workspaceId: string, sceneId: string, to: { chapterId: string; rank: string }) {
        return db.manuscriptScene.updateMany({ where: { workspaceId, id: sceneId, ...LIVE }, data: { chapterId: to.chapterId, rank: to.rank } });
    },

    // ─── Deletion (Phase 5.H-a, issue #71): soft for SCENE_RESTORE_DAYS, then the purge ───

    /**
     * Delete a live scene SOFTLY: hidden from every read above, its rows (text, note, links, card, versions, research
     * proposals) kept. `deletedAt` is the database's clock for app_user (trigger `manuscript_scene_deleted_at_is_now`;
     * the value written here is replaced). 0 when it was not live.
     */
    async softDelete(db: Db, workspaceId: string, bookId: string, sceneId: string): Promise<number> {
        return (await db.manuscriptScene.updateMany({ where: { workspaceId, bookId, id: sceneId, ...LIVE }, data: { deletedAt: new Date() } })).count;
    },

    /** A manuscript's scenes deleted after `since` (still restorable), newest deletion first, at most `take`. */
    async listDeleted(db: Db, workspaceId: string, bookId: string, since: Date, take: number) {
        return db.manuscriptScene.findMany({
            where: { workspaceId, bookId, deletedAt: { gt: since } },
            orderBy: [{ deletedAt: 'desc' }, { id: 'asc' }],
            select: { id: true, title: true, wordCount: true, deletedAt: true, chapterId: true, rank: true, chapter: { select: { title: true } } },
            take,
        });
    },

    /** How many recently deleted scenes each chapter holds (they go, for good, with a deleted chapter). */
    async deletedByChapter(db: Db, workspaceId: string, bookId: string): Promise<Map<string, number>> {
        const rows = await db.manuscriptScene.groupBy({ by: ['chapterId'], where: { workspaceId, bookId, deletedAt: { not: null } }, _count: { _all: true } });
        return new Map(rows.map((r) => [r.chapterId, r._count._all]));
    },

    /** A deleted scene still restorable (deleted after `since`), with what its restore needs; null otherwise. */
    async findDeleted(db: Db, workspaceId: string, bookId: string, sceneId: string, since: Date) {
        return db.manuscriptScene.findFirst({
            where: { workspaceId, bookId, id: sceneId, deletedAt: { gt: since } },
            select: { id: true, chapterId: true, rank: true, wordCount: true, deletedAt: true },
        });
    },

    /** Bring a restorable deleted scene back at `rank` in its chapter (deleted after `since`); 0 when it is not. */
    async restore(db: Db, workspaceId: string, bookId: string, sceneId: string, since: Date, rank: string): Promise<number> {
        return (await db.manuscriptScene.updateMany({ where: { workspaceId, bookId, id: sceneId, deletedAt: { gt: since } }, data: { deletedAt: null, rank } })).count;
    },

    /**
     * Scenes of EVERY workspace deleted at or before `cutoff` (the purge's discovery, outside row-level security under
     * `scene-purge-discovery`), oldest deletion first, at most `take`. Ids only.
     */
    async listPurgeDue(db: PrismaClient, cutoff: Date, take: number): Promise<Array<{ id: string; workspaceId: string; bookId: string }>> {
        return db.manuscriptScene.findMany({
            where: { deletedAt: { lte: cutoff } },
            orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
            select: { id: true, workspaceId: true, bookId: true },
            take,
        });
    },

    /**
     * Delete, for good, a scene deleted at or before `cutoff`, locked first (a restore that won the race leaves it
     * alone): everything that cascades from it goes with it. The trigger refuses any other hard delete.
     */
    async purge(db: Db, workspaceId: string, bookId: string, sceneId: string, cutoff: Date): Promise<number> {
        const locked = await db.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "ManuscriptScene" WHERE "workspaceId" = ${workspaceId} AND "bookId" = ${bookId} AND "id" = ${sceneId}
              AND "deletedAt" IS NOT NULL AND "deletedAt" <= ${cutoff} FOR UPDATE`;
        if (locked.length === 0) return 0;
        return (await db.manuscriptScene.deleteMany({ where: { workspaceId, bookId, id: sceneId, deletedAt: { lte: cutoff } } })).count;
    },
};

export const SceneLinkRepository = {
    async listForScene(db: Db, workspaceId: string, sceneId: string, take: number) {
        return db.sceneElementLink.findMany({ where: { workspaceId, sceneId }, select: { elementId: true, mentioned: true, explicit: true }, take });
    },

    /** Insert or update one link's two flags (a row of neither is removed by `prune`). */
    async upsert(db: Db, workspaceId: string, bookId: string, sceneId: string, elementId: string, flags: { mentioned: boolean; explicit: boolean }) {
        await db.sceneElementLink.upsert({
            where: { sceneId_elementId: { sceneId, elementId } },
            create: { workspaceId, bookId, sceneId, elementId, mentioned: flags.mentioned, explicit: flags.explicit },
            update: { mentioned: flags.mentioned, explicit: flags.explicit },
        });
    },

    async removeMany(db: Db, workspaceId: string, sceneId: string, elementIds: readonly string[]) {
        if (elementIds.length === 0) return;
        await db.sceneElementLink.deleteMany({ where: { workspaceId, sceneId, elementId: { in: [...elementIds] } } });
    },
};

export const SceneBeatRepository = {
    async listForScene(db: Db, workspaceId: string, sceneId: string, take: number) {
        return db.sceneBeatLink.findMany({ where: { workspaceId, sceneId }, select: { beatElementId: true }, take });
    },

    async add(db: Db, workspaceId: string, bookId: string, sceneId: string, beatIds: readonly string[]) {
        if (beatIds.length === 0) return;
        await db.sceneBeatLink.createMany({ data: beatIds.map((beatElementId) => ({ workspaceId, bookId, sceneId, beatElementId })), skipDuplicates: true });
    },

    async removeMany(db: Db, workspaceId: string, sceneId: string, beatIds: readonly string[]) {
        if (beatIds.length === 0) return;
        await db.sceneBeatLink.deleteMany({ where: { workspaceId, sceneId, beatElementId: { in: [...beatIds] } } });
    },

    /** How many scenes dramatise each of the beats (an aggregate, one row a beat). */
    async countForBeats(db: Db, workspaceId: string, bookId: string, beatIds: readonly string[]): Promise<Map<string, number>> {
        if (beatIds.length === 0) return new Map();
        const rows = await db.sceneBeatLink.groupBy({ by: ['beatElementId'], where: { workspaceId, bookId, beatElementId: { in: [...beatIds] }, ...OF_LIVE_SCENE }, _count: { _all: true } });
        return new Map(rows.map((r) => [r.beatElementId, r._count._all]));
    },

    /** The beat-to-scene links of the beats, at most `take`. */
    async linksForBeats(db: Db, workspaceId: string, bookId: string, beatIds: readonly string[], take: number) {
        if (beatIds.length === 0) return [];
        return db.sceneBeatLink.findMany({ where: { workspaceId, bookId, beatElementId: { in: [...beatIds] }, ...OF_LIVE_SCENE }, select: { beatElementId: true, sceneId: true }, take });
    },

    /** The scenes that dramatise a beat (ids), at most `take`. */
    async scenesOf(db: Db, workspaceId: string, bookId: string, beatElementId: string, take: number) {
        return db.sceneBeatLink.findMany({ where: { workspaceId, bookId, beatElementId, ...OF_LIVE_SCENE }, select: { sceneId: true }, take });
    },
};

export const SceneVersionRepository = {
    async latest(db: Db, workspaceId: string, sceneId: string) {
        return db.sceneVersion.findFirst({ where: { workspaceId, sceneId }, orderBy: { versionNumber: 'desc' }, select: { ...VERSION_META_SELECT, text: true } });
    },

    async list(db: Db, workspaceId: string, bookId: string, sceneId: string, opts: { before?: number; take: number }): Promise<SceneVersionMetaRow[]> {
        return db.sceneVersion.findMany({
            where: { workspaceId, bookId, sceneId, ...(opts.before !== undefined ? { versionNumber: { lt: opts.before } } : {}) },
            orderBy: { versionNumber: 'desc' },
            select: VERSION_META_SELECT,
            take: opts.take,
        });
    },

    async find(db: Db, workspaceId: string, bookId: string, sceneId: string, versionNumber: number) {
        return db.sceneVersion.findFirst({ where: { workspaceId, bookId, sceneId, versionNumber }, select: { ...VERSION_META_SELECT, text: true } });
    },

    async create(
        db: Db,
        workspaceId: string,
        data: { bookId: string; sceneId: string; versionNumber: number; text: string; wordCount: number; source: SceneVersionSource; restoredFromVersion: number | null; authorId: string | null },
    ) {
        return db.sceneVersion.create({
            data: {
                workspaceId,
                bookId: data.bookId,
                sceneId: data.sceneId,
                versionNumber: data.versionNumber,
                text: data.text,
                wordCount: data.wordCount,
                source: data.source,
                restoredFromVersion: data.restoredFromVersion,
                authorId: data.authorId,
            },
            select: VERSION_META_SELECT,
        });
    },

    /** An import's first versions, one statement a batch. */
    async createMany(db: Db, workspaceId: string, bookId: string, rows: ReadonlyArray<{ sceneId: string; text: string; wordCount: number }>, authorId: string | null) {
        return db.sceneVersion.createMany({
            data: rows.map((r) => ({ workspaceId, bookId, sceneId: r.sceneId, versionNumber: 1, text: r.text, wordCount: r.wordCount, source: 'IMPORT' as const, restoredFromVersion: null, authorId })),
        });
    },
};

/**
 * A PURGED scene's history (Phase 5.H-a, issue #71): its text, note and card versions, deleted for good once the scene
 * row is gone. The append-only trigger admits these deletes only for the scene the transaction names in the
 * `inkquisitor.scene_purge` setting (transaction-local) and only while no scene of that id stands. Called only by
 * `usecases/scene-purge.ts`, after the scene's own deletion, in its transaction.
 */
export const SceneHistoryRepository = {
    async deleteForGoneScene(db: Db, workspaceId: string, bookId: string, sceneId: string): Promise<{ versionCount: number; noteVersionCount: number; cardVersionCount: number }> {
        await db.$executeRaw`SELECT set_config('inkquisitor.scene_purge', ${sceneId}, true)`;
        const versions = await db.sceneVersion.deleteMany({ where: { workspaceId, bookId, sceneId } });
        const notes = await db.sceneNoteVersion.deleteMany({ where: { workspaceId, bookId, sceneId } });
        const cards = await db.sceneCardVersion.deleteMany({ where: { workspaceId, bookId, sceneId } });
        await db.$executeRaw`SELECT set_config('inkquisitor.scene_purge', '', true)`;
        return { versionCount: versions.count, noteVersionCount: notes.count, cardVersionCount: cards.count };
    },
};

export const SceneNoteVersionRepository = {
    async create(
        db: Db,
        workspaceId: string,
        data: { bookId: string; sceneId: string; versionNumber: number; note: string; source: BibleVersionSource; sourceFindingIds: readonly string[]; sourceResearchProposalId: string | null; authorId: string | null },
    ) {
        return db.sceneNoteVersion.create({
            data: {
                workspaceId,
                bookId: data.bookId,
                sceneId: data.sceneId,
                versionNumber: data.versionNumber,
                note: data.note,
                source: data.source,
                sourceFindingIds: [...data.sourceFindingIds],
                sourceResearchProposalId: data.sourceResearchProposalId,
                authorId: data.authorId,
            },
            select: { id: true, versionNumber: true },
        });
    },
};
