/**
 * The prose checks' tables (Phase 5.2, D34). Workspace-scoped: every query
 * runs inside `runInWorkspaceContext` AND filters by `workspaceId`, and by its
 * book or scene. No authorization and no validation here: the usecases
 * (`src/app-layer/usecases/prose-check*.ts`) ask permission and sanitise first.
 *
 * `ProseFinding.detail` and `ProseBookBaseline.baseline` are sealed and opened
 * by the field-encryption extension; this module reads and writes plaintext
 * and never filters on them. It READS scenes and bible elements and never
 * writes either (D3: a scene's text has one writer, `manuscript-text.ts`).
 */
import type { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

const CHECK_SELECT = {
    id: true,
    sceneId: true,
    revision: true,
    textKey: true,
    rulesVersion: true,
    configKey: true,
    styleElementId: true,
    rulesNotRun: true,
    textCut: true,
    findingsCut: true,
    charsChecked: true,
    wordsChecked: true,
    sentences: true,
    readingEase: true,
    gradeLevel: true,
    checkedAt: true,
} as const satisfies Prisma.SceneProseCheckSelect;
export type SceneProseCheckRow = Prisma.SceneProseCheckGetPayload<{ select: typeof CHECK_SELECT }>;

const FINDING_SELECT = { id: true, ruleId: true, severity: true, start: true, end: true, sentenceKey: true, detail: true } as const satisfies Prisma.ProseFindingSelect;
export type ProseFindingRow = Prisma.ProseFindingGetPayload<{ select: typeof FINDING_SELECT }>;

export interface NewFinding {
    ruleId: string;
    severity: string;
    start: number;
    end: number;
    sentenceKey: string;
    /** Sanitised JSON (`sanitiseFindingDetail`); sealed by the extension. */
    detail: string;
}

export type NewCheck = Omit<SceneProseCheckRow, 'id' | 'sceneId' | 'checkedAt'>;

export const ProseCheckRepository = {
    async findCheck(db: Db, workspaceId: string, bookId: string, sceneId: string): Promise<SceneProseCheckRow | null> {
        return db.sceneProseCheck.findFirst({ where: { workspaceId, bookId, sceneId }, select: CHECK_SELECT });
    },

    /** A check's findings, by position, at most `take`. */
    async listFindings(db: Db, workspaceId: string, checkId: string, take: number): Promise<ProseFindingRow[]> {
        return db.proseFinding.findMany({ where: { workspaceId, checkId }, select: FINDING_SELECT, orderBy: [{ start: 'asc' }, { id: 'asc' }], take });
    },

    async findFinding(db: Db, workspaceId: string, findingId: string) {
        return db.proseFinding.findFirst({
            where: { workspaceId, id: findingId },
            select: { id: true, ruleId: true, sentenceKey: true, check: { select: { bookId: true, sceneId: true } } },
        });
    },

    /** Replace the scene's check (one check a scene): the old findings go with the old row by cascade. Returns the new check's id. */
    async replaceCheck(db: Db, workspaceId: string, bookId: string, sceneId: string, check: NewCheck): Promise<string> {
        await db.sceneProseCheck.deleteMany({ where: { workspaceId, bookId, sceneId } });
        const row = await db.sceneProseCheck.create({ data: { workspaceId, bookId, sceneId, ...check }, select: { id: true } });
        return row.id;
    },

    /** The scene a check reads: its book, its current text (decrypted) and revision; null when it is gone or deleted (5.H-a). */
    async sceneForCheck(db: Db, workspaceId: string, sceneId: string) {
        return db.manuscriptScene.findFirst({ where: { workspaceId, id: sceneId, deletedAt: null }, select: { id: true, bookId: true, text: true, revision: true } });
    },

    async findSettings(db: Db, workspaceId: string, bookId: string) {
        return db.proseCheckSettings.findFirst({ where: { workspaceId, bookId }, select: { alexEnabled: true, rulesOff: true, updatedAt: true } });
    },

    async saveSettings(db: Db, workspaceId: string, bookId: string, settings: { alexEnabled: boolean; rulesOff: string[] }) {
        return db.proseCheckSettings.upsert({
            where: { workspaceId_bookId: { workspaceId, bookId } },
            create: { workspaceId, bookId, ...settings },
            update: settings,
            select: { alexEnabled: true, rulesOff: true },
        });
    },

    /** Which of the given (rule, sentence key) pairs the book has dismissed. */
    async dismissedKeys(db: Db, workspaceId: string, bookId: string, sentenceKeys: readonly string[]): Promise<Set<string>> {
        if (sentenceKeys.length === 0) return new Set();
        const keys = [...new Set(sentenceKeys)];
        const rows = await db.proseDismissal.findMany({ where: { workspaceId, bookId, sentenceKey: { in: keys } }, select: { ruleId: true, sentenceKey: true }, take: keys.length * 16 });
        return new Set(rows.map((r) => `${r.ruleId}\u0000${r.sentenceKey}`));
    },

    async countDismissals(db: Db, workspaceId: string, bookId: string): Promise<number> {
        return db.proseDismissal.count({ where: { workspaceId, bookId } });
    },

    /** Record a dismissal (a repeat is a no-op); past `max` the oldest go first. */
    async dismiss(db: Db, workspaceId: string, bookId: string, ruleId: string, sentenceKey: string, max: number): Promise<void> {
        // INSERT … ON CONFLICT DO NOTHING: an upsert with nothing to update is not run as one statement, so two
        // dismissals of one note at once (a double click) raced to a unique violation.
        await db.proseDismissal.createMany({ data: [{ workspaceId, bookId, ruleId, sentenceKey }], skipDuplicates: true });
        const count = await db.proseDismissal.count({ where: { workspaceId, bookId } });
        if (count > max) {
            const oldest = await db.proseDismissal.findMany({ where: { workspaceId, bookId }, select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: count - max });
            await db.proseDismissal.deleteMany({ where: { workspaceId, id: { in: oldest.map((o) => o.id) } } });
        }
    },

    async clearDismissals(db: Db, workspaceId: string, bookId: string): Promise<number> {
        const r = await db.proseDismissal.deleteMany({ where: { workspaceId, bookId } });
        return r.count;
    },

    /** The book's scenes' ids and word counts in no particular order (the baseline picks what it reads), at most `take`. */
    async listSceneSizes(db: Db, workspaceId: string, bookId: string, take: number) {
        return db.manuscriptScene.findMany({ where: { workspaceId, bookId, deletedAt: null }, select: { id: true, wordCount: true }, orderBy: { id: 'asc' }, take });
    },

    /** Scenes' stored text, at most `ids.length` (the baseline's read, a batch at a time). */
    async sceneTexts(db: Db, workspaceId: string, bookId: string, ids: readonly string[]) {
        if (ids.length === 0) return [];
        return db.manuscriptScene.findMany({ where: { workspaceId, bookId, id: { in: [...ids] }, deletedAt: null }, select: { id: true, text: true }, take: ids.length });
    },

    /** A chapter's scenes' ids, in manuscript order, at most `take`. */
    async chapterSceneIds(db: Db, workspaceId: string, bookId: string, chapterId: string, take: number): Promise<string[]> {
        const rows = await db.manuscriptScene.findMany({ where: { workspaceId, bookId, chapterId, deletedAt: null }, select: { id: true, rank: true }, take });
        return rows.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)).map((r) => r.id);
    },

    /** The book's CHARACTER elements' names, oldest first, at most `take`. */
    async characterNames(db: Db, workspaceId: string, bookId: string, take: number) {
        return db.bibleElement.findMany({ where: { workspaceId, bookId, kind: 'CHARACTER' }, select: { id: true, name: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take });
    },

    /** The book's STYLE elements with their fields (the style sheet's candidates), at most `take`. */
    async styleElements(db: Db, workspaceId: string, bookId: string, take: number) {
        return db.bibleElement.findMany({
            where: { workspaceId, bookId, kind: 'STYLE' },
            select: { id: true, name: true, createdAt: true, fields: { select: { key: true, value: true }, take: 64 } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take,
        });
    },
};

/** A check's findings: the ONE write of `ProseFinding` (its `detail` sanitised by `sanitiseFindingDetail` first, then sealed). */
export const ProseFindingRepository = {
    async createMany(db: Db, workspaceId: string, checkId: string, findings: readonly NewFinding[]): Promise<void> {
        if (findings.length === 0) return;
        // One statement; the encryption extension seals each row's `detail`.
        await db.proseFinding.createMany({ data: findings.map((f) => ({ workspaceId, checkId, ...f })) });
    },
};

/** The book's word baseline (encrypted whole): the ONE write of `ProseBookBaseline`. */
export const ProseBaselineRepository = {
    async find(db: Db, workspaceId: string, bookId: string) {
        return db.proseBookBaseline.findFirst({ where: { workspaceId, bookId }, select: { baseline: true, computedAt: true, totalWords: true, cut: true } });
    },

    async save(db: Db, workspaceId: string, bookId: string, data: { baseline: string; totalWords: number; scenesRead: number; cut: boolean; computedAt: Date }) {
        await db.proseBookBaseline.upsert({ where: { workspaceId_bookId: { workspaceId, bookId } }, create: { workspaceId, bookId, ...data }, update: data });
    },
};
