/**
 * A multi-workspace job's ROUND-ROBIN CURSOR (Phase 4.H-b, #60.4): the last
 * workspace its discovery served, so the next tick starts after it and every
 * busy workspace is reached within ⌈busy workspaces ÷ per-tick bound⌉ ticks,
 * however many there are and however old their backlogs. Global (no workspace
 * data: a job name and a workspace id), read and written only through
 * `runWithoutRls` by the job's own discovery reason.
 */
import type { PrismaClient } from '@prisma/client';

export const JobCursorRepository = {
    async read(db: PrismaClient, name: string): Promise<string> {
        const row = await db.jobCursor.findUnique({ where: { name }, select: { cursor: true } });
        return row?.cursor ?? '';
    },
    async save(db: PrismaClient, name: string, cursor: string): Promise<void> {
        await db.jobCursor.upsert({ where: { name }, create: { name, cursor }, update: { cursor } });
    },
};

/**
 * Take up to `take` items of a list ordered by workspace id, starting AFTER `cursor` and wrapping round to the start:
 * `after` reads those past the cursor, `upTo` those at or before it (both in workspace order, bounded). The new
 * cursor is the last workspace taken (the one the next tick starts after).
 */
export async function fromCursor<T extends { workspaceId: string }>(
    cursor: string,
    take: number,
    after: (cursor: string, take: number) => Promise<T[]>,
    upTo: (cursor: string, take: number) => Promise<T[]>,
): Promise<{ items: T[]; next: string }> {
    const first = await after(cursor, take);
    const rest = first.length < take && cursor !== '' ? await upTo(cursor, take - first.length) : [];
    const items = [...first, ...rest];
    return { items, next: items.length > 0 ? items[items.length - 1].workspaceId : cursor };
}

/** The lists interleaved, first of each, then second of each…, cut at `take` (a tick's fair share between workspaces). */
export function roundRobin<T>(lists: readonly (readonly T[])[], take: number): T[] {
    const out: T[] = [];
    for (let i = 0; out.length < take; i++) {
        let any = false;
        for (const l of lists) {
            if (i < l.length) {
                any = true;
                out.push(l[i]);
                if (out.length >= take) break;
            }
        }
        if (!any) break;
    }
    return out;
}
