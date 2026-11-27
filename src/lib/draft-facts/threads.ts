/**
 * THE UNPAID SETUP (Phase 5.3, D35 item 4): a promise or a clue still OPEN whose PLANT a scene was confirmed to make,
 * and which no confirmed PAY-OFF follows in the manuscript — from the first planting scene to the book's end. It is
 * the signal 4.4's continuity questions already ask about an open thread, now with the scene that set it up: the
 * question's value is raised (`CONTINUITY_VALUE.UNPAID_SETUP`) and the Continuity page names it. Pure and client-safe.
 * Manuscript order is (part, chapter, scene) by their fractional ranks, compared in code (`compareRanks`).
 */
import { compareRanks } from '@/lib/bible/story-order';

export interface SceneOrderKey {
    readonly partRank: string;
    readonly chapterRank: string;
    readonly sceneRank: string;
}

export function compareSceneOrder(a: SceneOrderKey, b: SceneOrderKey): number {
    return compareRanks(a.partRank, b.partRank) || compareRanks(a.chapterRank, b.chapterRank) || compareRanks(a.sceneRank, b.sceneRank);
}

/** Is the thread an unpaid setup? `links` are its CONFIRMED links, each with its scene's place (a scene gone counts for nothing). */
export function isUnpaidSetup(thread: { kind: string; state: string }, links: ReadonlyArray<{ role: string; order: SceneOrderKey | null }>): boolean {
    if (thread.state !== 'OPEN' || (thread.kind !== 'PROMISE' && thread.kind !== 'CLUE')) return false;
    const plants = links.filter((l) => l.role === 'PLANTS' && l.order).map((l) => l.order!);
    if (plants.length === 0) return false;
    const first = plants.reduce((a, b) => (compareSceneOrder(a, b) <= 0 ? a : b));
    return !links.some((l) => l.role === 'PAYS' && l.order && compareSceneOrder(l.order, first) >= 0);
}
