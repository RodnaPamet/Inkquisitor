/**
 * A scene's card and its history (Phase 5.3). Every query filters by `workspaceId` and runs in the caller's
 * `runInWorkspaceContext` transaction. The card's fields are encrypted by the extension and sanitised by
 * `sanitiseSceneCardField` (`src/lib/manuscript/storage.ts`) before the one writer (`usecases/scene-card.ts`) calls
 * `upsert`; a version's snapshot by `serialiseSceneCardSnapshot`. Card versions are append-only (trigger).
 */
import type { Prisma } from '@prisma/client';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import type { SceneCardValues } from '@/lib/manuscript/scene-card';

type Db = PrismaTx;

const CARD_SELECT = { id: true, sceneId: true, goal: true, conflict: true, outcome: true, change: true, version: true, updatedAt: true } as const satisfies Prisma.SceneCardSelect;
export type SceneCardRow = Prisma.SceneCardGetPayload<{ select: typeof CARD_SELECT }>;

export const SceneCardRepository = {
    async find(db: Db, workspaceId: string, bookId: string, sceneId: string): Promise<SceneCardRow | null> {
        return db.sceneCard.findFirst({ where: { workspaceId, bookId, sceneId }, select: CARD_SELECT });
    },
    /** Some scenes' cards (the interview's subjects), in one read. */
    async forScenes(db: Db, workspaceId: string, bookId: string, sceneIds: readonly string[]): Promise<SceneCardRow[]> {
        if (sceneIds.length === 0) return [];
        return db.sceneCard.findMany({ where: { workspaceId, bookId, sceneId: { in: [...sceneIds] } }, take: sceneIds.length, select: CARD_SELECT });
    },
    /** Write the card's whole state at its next version (the caller holds the scene's lock and checked the version). */
    async upsert(db: Db, workspaceId: string, bookId: string, sceneId: string, data: SceneCardValues & { version: number }) {
        const values = { goal: data.goal, conflict: data.conflict, outcome: data.outcome, change: data.change, version: data.version };
        return db.sceneCard.upsert({
            where: { workspaceId_bookId_sceneId: { workspaceId, bookId, sceneId } },
            create: { workspaceId, bookId, sceneId, ...values },
            update: values,
            select: CARD_SELECT,
        });
    },
    /** Some scenes' titles (the review page's card proposals), in one read; never the text. */
    async scenesByIds(db: Db, workspaceId: string, bookId: string, sceneIds: readonly string[]) {
        if (sceneIds.length === 0) return [];
        return db.manuscriptScene.findMany({ where: { workspaceId, bookId, id: { in: [...sceneIds] } }, take: sceneIds.length, select: { id: true, title: true } });
    },
    /**
     * A scene as a scene interview reads it (Phase 5.3): its title, text (decrypted by the extension; sent only as a
     * fenced, bounded data block), chapter title, point of view, setting, and the first of its beats and linked elements
     * (its carrier is the first of these the book still holds).
     */
    async sceneForInterview(db: Db, workspaceId: string, bookId: string, sceneId: string) {
        return db.manuscriptScene.findFirst({
            where: { workspaceId, bookId, id: sceneId },
            select: {
                id: true,
                title: true,
                text: true,
                povElementId: true,
                settingElementId: true,
                chapter: { select: { title: true } },
                beatLinks: { select: { beatElementId: true }, orderBy: { beatElementId: 'asc' }, take: 1 },
                elementLinks: { select: { elementId: true }, orderBy: { elementId: 'asc' }, take: 1 },
            },
        });
    },
};

/** A card's history (append-only by trigger; its snapshot `serialiseSceneCardSnapshot`'s). */
export const SceneCardVersionRepository = {
    async createVersion(db: Db, workspaceId: string, data: { bookId: string; sceneId: string; versionNumber: number; snapshot: string; source: 'MANUAL' | 'INTERVIEW'; sourceAnswerIds: readonly string[]; authorId: string | null }) {
        return db.sceneCardVersion.create({ data: { workspaceId, ...data, sourceAnswerIds: [...data.sourceAnswerIds] }, select: { id: true, versionNumber: true } });
    },
    async listVersions(db: Db, workspaceId: string, bookId: string, sceneId: string, take: number) {
        return db.sceneCardVersion.findMany({ where: { workspaceId, bookId, sceneId }, orderBy: { versionNumber: 'desc' }, take, select: { versionNumber: true, source: true, createdAt: true } });
    },
};
