/**
 * The interview dial defaults (Phase 2.3): one row per workspace
 * (`WorkspaceInterviewDefaults`) and one per book (`BookInterviewDefaults`).
 * Workspace-scoped: every query runs inside `runInWorkspaceContext` (the
 * `workspace_isolation` policy) AND filters by `workspaceId`. No authorization
 * and no validation here: `src/app-layer/usecases/interview-defaults.ts` asks
 * permission and validates first. A NULL column passes its dial on to the
 * layer below (`resolveDials`).
 */
import { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

const DEFAULTS_SELECT = {
    depth: true,
    detail: true,
    personaKeys: true,
    offerRecommended: true,
    preferChoice: true,
    updatedAt: true,
} as const;

export type DefaultsRow = Prisma.WorkspaceInterviewDefaultsGetPayload<{ select: typeof DEFAULTS_SELECT }>;

/** A whole layer as stored: each dial a value, or null to pass it on. */
export interface DefaultsWrite {
    depth: number | null;
    detail: number | null;
    personaKeys: string[] | null;
    offerRecommended: boolean | null;
    preferChoice: boolean | null;
}

function data(w: DefaultsWrite) {
    return {
        depth: w.depth,
        detail: w.detail,
        personaKeys: w.personaKeys === null ? Prisma.DbNull : w.personaKeys,
        offerRecommended: w.offerRecommended,
        preferChoice: w.preferChoice,
    };
}

export const InterviewDefaultsRepository = {
    findForWorkspace(db: Db, workspaceId: string): Promise<DefaultsRow | null> {
        return db.workspaceInterviewDefaults.findFirst({ where: { workspaceId }, select: DEFAULTS_SELECT });
    },

    /** Replace the workspace's layer (the row is made on first write). */
    upsertForWorkspace(db: Db, workspaceId: string, w: DefaultsWrite): Promise<DefaultsRow> {
        return db.workspaceInterviewDefaults.upsert({
            where: { workspaceId },
            create: { workspaceId, ...data(w) },
            update: data(w),
            select: DEFAULTS_SELECT,
        });
    },

    findForBook(db: Db, workspaceId: string, bookId: string): Promise<DefaultsRow | null> {
        return db.bookInterviewDefaults.findFirst({ where: { workspaceId, bookId }, select: DEFAULTS_SELECT });
    },

    /** Replace the book's layer (the row is made on first write). */
    upsertForBook(db: Db, workspaceId: string, bookId: string, w: DefaultsWrite): Promise<DefaultsRow> {
        return db.bookInterviewDefaults.upsert({
            where: { workspaceId_bookId: { workspaceId, bookId } },
            create: { workspaceId, bookId, ...data(w) },
            update: data(w),
            select: DEFAULTS_SELECT,
        });
    },
};
