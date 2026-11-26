/**
 * `logEvent(ctx, …)` — the one way application code writes to the audit
 * trail. It routes through `appendAuditEntry` (`src/lib/audit/audit-writer.ts`),
 * which hash-chains the row onto the workspace's trail under row-level
 * security.
 *
 * `details` carries ids, counts and codes only — never author text, an email
 * address, a password or a token (roadmap rule 4). The trail is read by the
 * workspace's OWNER and is immutable: what goes in cannot be taken out.
 *
 * Pass `{ db }` to append inside a transaction the caller holds (under the
 * workspace's RLS), so the row commits or rolls back with the change it
 * records. Without it the append is a transaction of its own.
 *
 * Adapted from inflect-compliance's `src/app-layer/events/audit.ts` (see
 * docs/carve-manifest.md): no legacy free-text `details`, no metadata blob,
 * and a closed set of action names.
 */
import type { RequestContext } from '@/app-layer/types';
import { appendAuditEntry, appendAuditEntryWithin, type AuditActorType } from '@/lib/audit/audit-writer';
import type { PrismaTx } from '@/lib/db/rls-middleware';

/** Every action the trail records. Add one here, with its emitter. */
export type AuditAction =
    | 'USER_SIGNED_UP'
    | 'WORKSPACE_CREATED'
    | 'MEMBERSHIP_CREATED'
    | 'MEMBERSHIP_ROLE_CHANGED'
    | 'MEMBERSHIP_REMOVED'
    | 'USER_SIGNED_IN'
    | 'USER_SIGN_IN_FAILED'
    | 'USER_SIGNED_OUT'
    | 'ACCOUNT_LINKED'
    | 'ACCOUNT_CLAIMED'
    | 'SESSION_REVOKED'
    | 'AUTHZ_DENIED'
    | 'BOOK_CREATED'
    | 'BOOK_UPDATED'
    | 'BOOK_DELETED'
    | 'BOOK_RESTORED'
    | 'BOOK_PURGED'
    | 'BIBLE_ELEMENT_CREATED'
    | 'BIBLE_ELEMENT_UPDATED'
    | 'BIBLE_ELEMENT_DELETED'
    | 'BIBLE_ELEMENT_MOVED'
    | 'BIBLE_ORDER_REBALANCED'
    | 'BIBLE_FIELDS_UPDATED'
    | 'BIBLE_RELATION_CREATED'
    | 'BIBLE_RELATION_DELETED'
    | 'BIBLE_RELATION_FIELDS_SAVED'
    | 'BIBLE_VERSION_RESTORED'
    | 'BIBLE_EXPORTED'
    | 'BIBLE_BUNDLE_IMPORTED'
    | 'BIBLE_CONCEPT_NOTE_IMPORTED'
    | 'ENRICHMENT_RECONCILED'
    | 'ENRICHMENT_PROPOSAL_ACCEPTED'
    | 'ENRICHMENT_PROPOSAL_REJECTED'
    | 'RESEARCH_BRIEF_CREATED'
    | 'RESEARCH_SOURCE_ATTACHED'
    | 'RESEARCH_RUN_DISPATCHED'
    | 'RESEARCH_RUN_FINISHED'
    | 'RESEARCH_PROPOSAL_ACCEPTED'
    | 'RESEARCH_PROPOSAL_REJECTED'
    | 'RESEARCH_FINDING_KEPT'
    | 'INTERVIEW_STARTED'
    | 'INTERVIEW_ROUND_OPENED'
    | 'INTERVIEW_ROUND_CLOSED'
    | 'INTERVIEW_ENDED'
    | 'INTERVIEW_DEFAULTS_UPDATED'
    | 'INTERVIEW_QUESTION_REPHRASED'
    | 'STORY_MAP_SAVED'
    | 'STORY_MAP_RESTORED'
    | 'STORY_MAP_CASCADED'
    | 'SOURCE_UPLOADED'
    | 'SOURCE_REMOVED'
    | 'SOURCE_INGEST_DISPATCHED'
    | 'SOURCE_INGEST_FINISHED'
    | 'SOURCE_SERIES_OPT_IN_CHANGED'
    | 'STORY_FACT_DECIDED'
    | 'STORY_FACTS_BULK_CONFIRMED'
    | 'STORY_FACT_OVERRIDE_SET'
    | 'STORY_FACT_OVERRIDE_CLEARED'
    | 'BIBLE_FACTS_EXTRACTED'
    | 'STORY_FACT_PROPOSAL_DECIDED'
    // Phase 4.2 (D28): the nightly continuity check, the registries, propagation debt.
    | 'CONTINUITY_CHECKED'
    | 'STORY_THREAD_CREATED'
    | 'STORY_THREAD_UPDATED'
    | 'STORY_THREAD_DELETED'
    | 'STORY_THREAD_PROPOSAL_DECIDED'
    | 'STALE_FLAG_DISMISSED'
    // Phase 4.3 (D29): book-level interrogation.
    | 'STRESS_TEST_REQUESTED'
    | 'STRESS_TEST_FINISHED'
    | 'GAP_HUNT_RUN'
    | 'INTERVIEW_COMPACTED'
    /** Phase 4.4 (D30): the author chose to go on past the minor questions. */
    | 'INTERVIEW_MINOR_ACCEPTED';

export interface AuditEventPayload {
    action: AuditAction;
    entityType: string;
    entityId: string | null;
    /** Ids, counts, codes. Never author text or a credential. */
    details?: Record<string, unknown>;
}

/** The context an event needs: a workspace to chain into, and whoever acted (if anyone). */
export type AuditContext = Pick<RequestContext, 'requestId' | 'userId'> & { workspaceId: string };

export async function logEvent(
    ctx: AuditContext,
    payload: AuditEventPayload,
    options: { db?: PrismaTx; actorType?: AuditActorType } = {},
): Promise<void> {
    const input = {
        workspaceId: ctx.workspaceId,
        actorUserId: ctx.userId ?? null,
        actorType: options.actorType ?? (ctx.userId ? 'USER' : 'SYSTEM'),
        action: payload.action,
        entityType: payload.entityType,
        entityId: payload.entityId,
        detailsJson: payload.details ?? {},
        requestId: ctx.requestId,
    } as const;
    if (options.db) {
        await appendAuditEntryWithin(options.db, input);
    } else {
        await appendAuditEntry(input);
    }
}
