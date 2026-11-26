/**
 * Propagation debt's one reading (Phase 4.2, D28): a flag stands while its entry
 * has not been saved since it was raised. Not a public usecase module: it runs
 * inside a caller's transaction. A save is any version of the entry numbered
 * past the flag's `downstreamVersionNumber` that is not a reorder
 * (`movedInOrder`): a reorder changes nothing a citation rests on.
 */
import { StaleFlagRepository, type StaleFlagRow } from '@/app-layer/repositories/continuity.repository';
import type { PrismaTx } from '@/lib/db/rls-middleware';

/** The open flags whose entry has not been saved (a reorder aside) since they were raised. */
export async function standingStaleFlags(db: PrismaTx, workspaceId: string, rows: readonly StaleFlagRow[]): Promise<{ standing: StaleFlagRow[]; cleared: StaleFlagRow[] }> {
    const newest = await StaleFlagRepository.newestContentVersions(db, workspaceId, [...new Set(rows.map((r) => r.elementId))]);
    const standing: StaleFlagRow[] = [];
    const cleared: StaleFlagRow[] = [];
    for (const r of rows) ((newest.get(r.elementId) ?? 0) > r.downstreamVersionNumber ? cleared : standing).push(r);
    return { standing, cleared };
}

