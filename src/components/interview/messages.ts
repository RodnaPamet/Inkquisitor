'use client';

/**
 * The interview's words for what the server names by code (Phase 2.4): a stop
 * reason (`InterviewSession.stopReason`) and a refusal (`details.reason`). The
 * words come from next-intl (`interview.stop`, `interview.errors`), never from
 * the server's English message; a code this table does not know reads as the
 * generic sentence, so a reason added on the server never shows a raw code.
 */
import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { BibleKind } from '@/lib/bible/kinds';
import { packOfName } from '@/lib/interview/setup';
import type { StopReason } from '@/lib/interview/vocabulary';

/**
 * Every stop reason, worded. Keyed on the closed `StopReason` list, so a
 * reason the engine adds (2.3's PACK_CHANGED) fails `tsc` here until it has a
 * sentence.
 */
const STOP_MESSAGE_KEYS: Readonly<Record<StopReason, StopReason>> = {
    FRONTIER_EMPTY: 'FRONTIER_EMPTY',
    NOTHING_AT_DEPTH: 'NOTHING_AT_DEPTH',
    ROUND_BUDGET: 'ROUND_BUDGET',
    TOKEN_BUDGET: 'TOKEN_BUDGET',
    WORKSPACE_CEILING: 'WORKSPACE_CEILING',
    KILL_SWITCH: 'KILL_SWITCH',
    AUTHOR_STOPPED: 'AUTHOR_STOPPED',
    PROVIDER_FAILURE: 'PROVIDER_FAILURE',
    NO_ACCEPTABLE_QUESTION: 'NO_ACCEPTABLE_QUESTION',
    GUARD_REFUSED: 'GUARD_REFUSED',
    PACK_CHANGED: 'PACK_CHANGED',
};

/** The refusals the interview words on its own. */
export const INTERVIEW_WORDED_REASONS = [
    'AI_UNAVAILABLE',
    'SCOPE_EMPTY',
    'ROUND_OPEN',
    'ROUND_GENERATING',
    'ROUND_NOT_OPEN',
    'ROUND_HAS_UNANSWERED',
    'INTERVIEW_ENDED',
    'INTERVIEW_NOT_ACTIVE',
    'ANSWER_REQUIRED',
    'ANSWER_TOO_LONG',
    'ANSWER_SHAPE',
    'NOT_AN_OPTION',
    'NO_RECOMMENDATION',
    'ANSWER_REVISIONS_EXHAUSTED',
    'QUESTION_SUPERSEDED',
    'QUESTION_ANSWERED',
    'REPHRASE_LIMIT',
    'NO_REPHRASE',
    'ANSWERED_IN_BIBLE',
    'PACK_CHANGED',
    'TOKEN_BUDGET',
    'WORKSPACE_CEILING',
    // Phase 2.H: the workspace holds as many streams as it may (`src/lib/http/stream-capacity.ts`).
    'STREAM_CAPACITY',
    // Issue #32, item 5: the workspace's model-call rate.
    'MODEL_RATE_LIMITED',
    // Phase 2.3: production with no passing evaluation record for a pack the session would mount.
    'PACKS_NOT_MOUNTABLE',
] as const;

/** The `problem` a PACK_CHANGED stop records (`stopDetail.problem`): PACK_CHANGED, or PACK_NOT_PINNED for a session from before pinning. */
function stopProblemOf(detail: unknown): string | null {
    const problem = detail && typeof detail === 'object' ? (detail as { problem?: unknown }).problem : null;
    return typeof problem === 'string' ? problem : null;
}

/**
 * A stop reason in words. A PACK_CHANGED stop whose detail says the session was
 * never pinned (a 2.2 session) says so: such a session stays paused for good,
 * and the author needs to start another.
 */
export function useStopMessage(): (reason: string | null, detail?: unknown) => string {
    const t = useTranslations('interview.stop');
    return useCallback(
        (reason: string | null, detail?: unknown) => {
            if (reason === 'PACK_CHANGED' && stopProblemOf(detail) === 'PACK_NOT_PINNED') return t('PACK_NOT_PINNED');
            if (reason && reason in STOP_MESSAGE_KEYS) return t(STOP_MESSAGE_KEYS[reason as StopReason]);
            return t('generic');
        },
        [t],
    );
}

/** The pack names a 503 `PACKS_NOT_MOUNTABLE` lists (`details.packs[].name`), in order, at most once each. */
export function refusedPackNames(details: unknown): string[] {
    const packs = details && typeof details === 'object' ? (details as { packs?: unknown }).packs : null;
    if (!Array.isArray(packs)) return [];
    const names = packs.map((p) => (p && typeof p === 'object' ? (p as { name?: unknown }).name : null)).filter((n): n is string => typeof n === 'string');
    return [...new Set(names)];
}

/**
 * A refusal in words. A 503 is "AI is not available here" whatever 2.1 named
 * in `details.reason` (no key, the kill switch, …): to the author, those are
 * one thing, and the codes are not spelled here (a client chunk naming a
 * server variable fails the build's check). `PACKS_NOT_MOUNTABLE` names the
 * packs its `details` list: a persona by its name, a craft pack by its kind's
 * label (`kindLabels`, template product text) — a name this client does not
 * know is left out rather than shown raw.
 */
export function useInterviewErrorMessage(kindLabels?: Partial<Record<BibleKind, string>>): (reason: string | null, status?: number, details?: unknown) => string {
    const t = useTranslations('interview.errors');
    const tPersona = useTranslations('interview.personas');
    return useCallback(
        (reason: string | null, status?: number, details?: unknown) => {
            if (reason === 'PACKS_NOT_MOUNTABLE') {
                const named = refusedPackNames(details)
                    .map((name) => {
                        const pack = packOfName(name);
                        if (!pack) return null;
                        if (pack.group === 'persona') return t('packPersona', { name: tPersona(`${pack.key}.name`) });
                        const kind = kindLabels?.[pack.kind];
                        return kind ? t('packCraft', { kind }) : null;
                    })
                    .filter((n): n is string => n !== null);
                if (named.length > 0) return t('PACKS_NOT_MOUNTABLE_NAMED', { packs: named.join(', ') });
            }
            if (reason && (INTERVIEW_WORDED_REASONS as readonly string[]).includes(reason)) return t(reason);
            if (status === 503) return t('AI_UNAVAILABLE');
            return t('generic');
        },
        [t, tPersona, kindLabels],
    );
}
