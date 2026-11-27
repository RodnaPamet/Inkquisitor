/**
 * The full export's reads (Phase 5.H-a, D36): every table an author's data lives in, read a PAGE at a time in id
 * order (`after` the last id of the page before), each inside the caller's `runInWorkspaceContext` transaction, so
 * the encryption extension decrypts the author's text and row-level security bounds every read to the workspace.
 * Every read is bounded by `take`. No authorization here: `usecases/workspace-export.ts` asks `workspace.export`.
 *
 * Rows are read WHOLE (every scalar column): the export is "everything an author has", and an archive the author
 * holds must not drop a column because a select list forgot it. `toExportJson` turns a row into JSON (BigInt money
 * columns as strings, dates as ISO strings, a stored JSON document — a version's snapshot — parsed).
 */
import type { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

const after = (id: string | null) => (id ? { id: { gt: id } } : {});
const ID_ORDER = { id: 'asc' } as const;

/** One book's per-table page readers: `(db, workspaceId, bookId, after, take)` → rows in id order. */
export const BookExportReaders = {
    bibleVersions: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.bibleEntryVersion.findMany({ where: { workspaceId, bookId, ...after(a) }, orderBy: ID_ORDER, take }),
    relationVersions: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.bibleRelationVersion.findMany({ where: { workspaceId, bookId, ...after(a) }, orderBy: ID_ORDER, take }),
    sceneVersions: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.sceneVersion.findMany({ where: { workspaceId, bookId, ...after(a) }, orderBy: ID_ORDER, take }),
    sceneNoteVersions: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.sceneNoteVersion.findMany({ where: { workspaceId, bookId, ...after(a) }, orderBy: ID_ORDER, take }),
    sceneCardVersions: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.sceneCardVersion.findMany({ where: { workspaceId, bookId, ...after(a) }, orderBy: ID_ORDER, take }),
    mapSnapshots: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.mapSnapshot.findMany({ where: { workspaceId, map: { bookId }, ...after(a) }, orderBy: ID_ORDER, take, include: { map: { select: { kind: true } } } }),
    interviewSessions: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.interviewSession.findMany({ where: { workspaceId, bookId, ...after(a) }, orderBy: ID_ORDER, take }),
    interviewRounds: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.interviewRound.findMany({ where: { workspaceId, session: { bookId }, ...after(a) }, orderBy: ID_ORDER, take }),
    questions: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.question.findMany({ where: { workspaceId, bookId, ...after(a) }, orderBy: ID_ORDER, take }),
    answers: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.answer.findMany({ where: { workspaceId, question: { bookId }, ...after(a) }, orderBy: ID_ORDER, take }),
    enrichmentProposals: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.enrichmentProposal.findMany({ where: { workspaceId, bookId, ...after(a) }, orderBy: ID_ORDER, take }),
    facts: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.storyFact.findMany({ where: { workspaceId, OR: [{ bookId }, { source: { library: { bookId } } }], ...after(a) }, orderBy: ID_ORDER, take }),
    factProposals: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.storyFactProposal.findMany({ where: { workspaceId, bookId, ...after(a) }, orderBy: ID_ORDER, take }),
    threads: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.storyThread.findMany({ where: { workspaceId, bookId, ...after(a) }, orderBy: ID_ORDER, take }),
    threadSceneLinks: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.storyThreadSceneLink.findMany({ where: { workspaceId, bookId, ...after(a) }, orderBy: ID_ORDER, take }),
    researchBriefs: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.researchBrief.findMany({ where: { workspaceId, bookId, ...after(a) }, orderBy: ID_ORDER, take }),
    researchSources: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.researchSource.findMany({ where: { workspaceId, bookId, ...after(a) }, orderBy: ID_ORDER, take }),
    researchFindings: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.researchFinding.findMany({ where: { workspaceId, bookId, ...after(a) }, orderBy: ID_ORDER, take }),
    researchProposals: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.researchProposal.findMany({ where: { workspaceId, bookId, ...after(a) }, orderBy: ID_ORDER, take }),
    sources: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.source.findMany({ where: { workspaceId, library: { bookId }, ...after(a) }, orderBy: ID_ORDER, take }),
    sourceChunks: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.sourceChunk.findMany({ where: { workspaceId, source: { library: { bookId } }, ...after(a) }, orderBy: ID_ORDER, take }),
    stressTests: (db: Db, workspaceId: string, bookId: string, a: string | null, take: number) =>
        db.stressTest.findMany({ where: { workspaceId, bookId, ...after(a) }, orderBy: ID_ORDER, take }),
} as const;

export type BookExportTable = keyof typeof BookExportReaders;

/** The workspace's own series library (a library with no book): its sources and their chunks, a page at a time. */
export const SeriesExportReaders = {
    sources: (db: Db, workspaceId: string, a: string | null, take: number) => db.source.findMany({ where: { workspaceId, library: { bookId: null }, ...after(a) }, orderBy: ID_ORDER, take }),
    sourceChunks: (db: Db, workspaceId: string, a: string | null, take: number) =>
        db.sourceChunk.findMany({ where: { workspaceId, source: { library: { bookId: null } }, ...after(a) }, orderBy: ID_ORDER, take }),
    facts: (db: Db, workspaceId: string, a: string | null, take: number) =>
        db.storyFact.findMany({ where: { workspaceId, bookId: null, source: { library: { bookId: null } }, ...after(a) }, orderBy: ID_ORDER, take }),
} as const;

export const ExportRepository = {
    /** The workspace's LIVE books, oldest first (a book in Recently deleted is not exported: restore it first), at most `take`. */
    async books(db: Db, workspaceId: string, take: number) {
        return db.book.findMany({ where: { workspaceId, deletedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take });
    },

    /** The workspace's name and when it was made (its key and its deletion state are never exported). */
    async workspace(db: Db, workspaceId: string) {
        return db.workspace.findFirst({ where: { id: workspaceId }, select: { name: true, slug: true, createdAt: true } });
    },

    /** Its members' roles and names (no email: a collaborator's address is theirs, not the author's). */
    async members(db: Db, workspaceId: string, take: number) {
        return db.workspaceMembership.findMany({ where: { workspaceId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, select: { role: true, createdAt: true, user: { select: { id: true, name: true } } } });
    },

    /** A page of the workspace's audit trail, in id order (ids, counts and codes: the trail never holds author text). */
    async auditPage(db: Db, workspaceId: string, a: string | null, take: number) {
        return db.auditLog.findMany({ where: { workspaceId, ...after(a) }, orderBy: ID_ORDER, take });
    },

    /** A book's live scenes' cards (the outline's card fields), at most `take`. */
    async sceneCards(db: Db, workspaceId: string, bookId: string, take: number) {
        return db.sceneCard.findMany({ where: { workspaceId, bookId, scene: { deletedAt: null } }, take, select: { sceneId: true, goal: true, conflict: true, outcome: true, change: true, version: true } });
    },

    /** A book's live scenes' links to bible elements and beats, at most `take` each. */
    async sceneLinks(db: Db, workspaceId: string, bookId: string, take: number) {
        const [elements, beats] = [
            await db.sceneElementLink.findMany({ where: { workspaceId, bookId, scene: { deletedAt: null } }, take, select: { sceneId: true, elementId: true, mentioned: true, explicit: true } }),
            await db.sceneBeatLink.findMany({ where: { workspaceId, bookId, scene: { deletedAt: null } }, take, select: { sceneId: true, beatElementId: true } }),
        ];
        return { elements, beats };
    },
};

/** A row as JSON: BigInt as a decimal string, a Date as its ISO string, a stored JSON document (`snapshot`) parsed. */
export function toExportJson(row: unknown): unknown {
    if (row === null || row === undefined) return null;
    if (typeof row === 'bigint') return row.toString();
    if (row instanceof Date) return row.toISOString();
    if (Array.isArray(row)) return row.map(toExportJson);
    if (typeof row === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
            if (k === 'snapshot' && typeof v === 'string') {
                try {
                    out[k] = JSON.parse(v);
                    continue;
                } catch {
                    // a snapshot that is not JSON is kept as written
                }
            }
            out[k] = toExportJson(v);
        }
        return out;
    }
    return row;
}
