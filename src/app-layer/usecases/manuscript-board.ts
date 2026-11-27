/**
 * The plot board's scene cards (Phase 5.1, D33 addendum item B, owner decision
 * 2026-11-27): for each beat on the board, the scenes that dramatise it, as
 * DISPLAY DATA beside the map's rows — never a map row, never a tldraw store
 * record, never saved (rows are the source of truth; the canvas draws the cards
 * in an overlay from React state, as 3.3 draws its ghosts).
 *
 * Per beat: how many scenes name it (exact, an aggregate) and the first
 * `BOARD_SCENES_PER_BEAT` of them in manuscript order (part, chapter and scene
 * rank), each with its title and its chapter's title (author text, decrypted
 * here and shown as React text). A constant number of statements whatever the
 * board holds; the links read are bounded (`BOARD_SCENE_LINKS_READ_MAX`), and a
 * cut there only shows fewer cards — the count, and so the "+N more", stays exact.
 *
 * Read only, inside the caller's transaction (the map's view). It imports the
 * repository alone: nothing here writes, and nothing here reaches the scene
 * text writer.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { ManuscriptChapterRepository, ManuscriptPartRepository, ManuscriptSceneRepository, SceneBeatRepository } from '@/app-layer/repositories/manuscript.repository';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { compareRanks } from '@/lib/bible/story-order';
import { BOARD_SCENE_LINKS_READ_MAX, BOARD_SCENES_PER_BEAT } from '@/lib/canvas/limits';
import { PARTS_PER_MANUSCRIPT_MAX } from '@/lib/manuscript/vocabulary';

export interface BoardSceneCard {
    sceneId: string;
    /** The scene's title (author text), or null: untitled. */
    title: string | null;
    chapterTitle: string | null;
}

export interface BoardBeatScenes {
    beatElementId: string;
    /** Every scene that names the beat (exact). */
    total: number;
    /** The first of them in manuscript order, at most `BOARD_SCENES_PER_BEAT`. */
    scenes: BoardSceneCard[];
}

/** The scene cards of the beats on a plot board (beats no scene names are left out). */
export async function boardBeatScenesInTx(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, beatIds: readonly string[]): Promise<BoardBeatScenes[]> {
    if (beatIds.length === 0) return [];
    const counts = await SceneBeatRepository.countForBeats(db, ctx.workspaceId, bookId, beatIds);
    if (counts.size === 0) return [];
    const links = await SceneBeatRepository.linksForBeats(db, ctx.workspaceId, bookId, [...counts.keys()], BOARD_SCENE_LINKS_READ_MAX);
    const scenes = new Map((await ManuscriptSceneRepository.findOutline(db, ctx.workspaceId, bookId, [...new Set(links.map((l) => l.sceneId))])).map((s) => [s.id, s] as const));
    const chapters = new Map((await ManuscriptChapterRepository.findByIds(db, ctx.workspaceId, bookId, [...new Set([...scenes.values()].map((s) => s.chapterId))])).map((c) => [c.id, c] as const));
    const parts = new Map((await ManuscriptPartRepository.list(db, ctx.workspaceId, bookId, PARTS_PER_MANUSCRIPT_MAX + 1)).map((p) => [p.id, p.rank] as const));
    const orderOf = (id: string) => {
        const s = scenes.get(id)!;
        const c = chapters.get(s.chapterId);
        return [parts.get(c?.partId ?? '') ?? '', c?.rank ?? '', s.rank] as const;
    };
    const byBeat = new Map<string, string[]>();
    for (const l of links) {
        if (!scenes.has(l.sceneId)) continue;
        const list = byBeat.get(l.beatElementId);
        if (list) list.push(l.sceneId);
        else byBeat.set(l.beatElementId, [l.sceneId]);
    }
    const out: BoardBeatScenes[] = [];
    for (const [beatElementId, total] of counts) {
        const ordered = (byBeat.get(beatElementId) ?? []).sort((a, b) => {
            const [pa, ca, sa] = orderOf(a);
            const [pb, cb, sb] = orderOf(b);
            return compareRanks(pa, pb) || compareRanks(ca, cb) || compareRanks(sa, sb);
        });
        out.push({
            beatElementId,
            total,
            scenes: ordered.slice(0, BOARD_SCENES_PER_BEAT).map((id) => {
                const s = scenes.get(id)!;
                return { sceneId: id, title: s.title, chapterTitle: chapters.get(s.chapterId)?.title ?? null };
            }),
        });
    }
    return out.sort((a, b) => compareRanks(a.beatElementId, b.beatElementId));
}
