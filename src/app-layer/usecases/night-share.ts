/**
 * THE NIGHT'S SHARE, as a job passes it to its calls (Phase 5.3, D35 item 2 and addendum B): the one share of both
 * nightly purposes (`NIGHT_SHARE_PURPOSES`), with the calling purpose's HALF, whose binding depends on whether the other
 * purpose still has work this night (`night-share.ts` says how that is read). The ledger enforces both under its spend
 * lock; the job checks both before each call (`nightShareStop`).
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { ContinuityRunRepository } from '@/app-layer/repositories/continuity.repository';
import { DraftReadRunRepository } from '@/app-layer/repositories/draft-facts.repository';
import { monthlyCeilingMicroUsd } from '@/lib/ai/config';
import { CONTINUITY_PURPOSE } from '@/lib/continuity/prompt';
import { NIGHT_SHARE_HALF, NIGHT_SHARE_PURPOSES } from '@/lib/continuity/night-share';
import { CONTINUITY_NIGHT_WINDOW_MS, CONTINUITY_NIGHTLY_SHARE } from '@/lib/continuity/vocabulary';
import { DRAFT_READ_PURPOSE } from '@/lib/draft-facts/prompt';
import { env } from '@/env';
import type { NightlyShare } from './model-calls';

export type NightPurpose = 'continuity' | 'draft';

/** The night's share for a call of `purpose`, the night `nightKey` names, measured from `claim` less the night's window. */
export function nightShareFor(ctx: Pick<WorkspaceRequestContext, 'workspaceId'>, purpose: NightPurpose, input: { claim: Date; nightKey: string; capMicroUsd?: number }): NightlyShare {
    const capMicroUsd = input.capMicroUsd ?? Math.floor(CONTINUITY_NIGHTLY_SHARE * monthlyCeilingMicroUsd(env));
    const workspaceId = ctx.workspaceId;
    const nightKey = input.nightKey;
    return {
        purpose: NIGHT_SHARE_PURPOSES,
        since: new Date(input.claim.getTime() - CONTINUITY_NIGHT_WINDOW_MS),
        capMicroUsd,
        half:
            purpose === 'continuity'
                ? { purpose: CONTINUITY_PURPOSE, capMicroUsd: Math.floor(capMicroUsd * NIGHT_SHARE_HALF), otherHasWork: (db) => DraftReadRunRepository.workTonight(db, workspaceId, nightKey) }
                : { purpose: DRAFT_READ_PURPOSE, capMicroUsd: Math.floor(capMicroUsd * NIGHT_SHARE_HALF), otherHasWork: (db) => ContinuityRunRepository.liveTonight(db, workspaceId, nightKey) },
    };
}
