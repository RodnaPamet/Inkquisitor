/**
 * ONE WORKSPACE'S FAILURE IS THAT WORKSPACE'S (Phase 4.H-a).
 *
 * A job that serves every workspace (the minutely fact-layer dispatcher, the
 * nightly continuity dispatcher) runs each workspace's part in that
 * workspace's own context. Before 4.H-a a throw there — most plainly a
 * workspace whose data key cannot be unwrapped, which fails before its
 * transaction opens — ended the whole job, so one broken workspace stopped
 * extraction, embedding or the nightly check for every other.
 *
 * `servedWorkspace` runs one workspace's part and, when it throws, logs the
 * failure (ids and a code, never a message: a third party's message can quote
 * what it was given, and an AppError's is not needed), counts it in the
 * `job.workspace.skipped` metric, and returns `null` so the caller skips that
 * workspace and goes on. The job still fails for what is its own (discovery).
 */
import { WorkspaceKeyUnavailableError } from '@/lib/security/workspace-key-manager';
import { logger } from '@/lib/observability/logger';
import { recordJobWorkspaceSkipped } from '@/lib/observability/metrics';
import { safeErrorMeta } from '@/lib/observability/safe-error';

/** The code a skipped workspace is logged and counted under: never free text. */
export function workspaceFailureCode(err: unknown): string {
    if (err instanceof WorkspaceKeyUnavailableError) return err.code;
    const meta = safeErrorMeta(err);
    return meta.code ?? meta.name;
}

/**
 * Run one workspace's part of a multi-workspace job; on a throw, log it with
 * the ids given and a code, count it, and return null (the caller skips it).
 */
export async function servedWorkspace<T>(jobName: string, ids: { workspaceId: string } & Record<string, string>, part: () => Promise<T>): Promise<T | null> {
    try {
        return await part();
    } catch (err) {
        const code = workspaceFailureCode(err);
        logger.error('job.workspace_skipped', { component: 'jobs', job: jobName, ...ids, code });
        recordJobWorkspaceSkipped({ jobName, code });
        return null;
    }
}
