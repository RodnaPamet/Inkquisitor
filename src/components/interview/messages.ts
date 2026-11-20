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
};

/**
 * Stop reasons the server may record before this branch's `StopReason` names
 * them: 2.3's PACK_CHANGED (a pinned pack changed). Worded already, so a 2.3
 * server's pause never reads as the generic sentence; when 2.3 merges, the
 * value joins `StopReason` and moves into the table above.
 */
const FORTHCOMING_STOP_REASONS: readonly string[] = ['PACK_CHANGED'];

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
    'TOKEN_BUDGET',
    'WORKSPACE_CEILING',
    // Phase 2.3: production with no passing evaluation record for a pack the session would mount.
    'PACKS_NOT_MOUNTABLE',
] as const;

export function useStopMessage(): (reason: string | null) => string {
    const t = useTranslations('interview.stop');
    return useCallback(
        (reason: string | null) => {
            if (reason && reason in STOP_MESSAGE_KEYS) return t(STOP_MESSAGE_KEYS[reason as StopReason]);
            if (reason && FORTHCOMING_STOP_REASONS.includes(reason)) return t(reason);
            return t('generic');
        },
        [t],
    );
}

/**
 * A refusal in words. A 503 is "AI is not available here" whatever 2.1 named
 * in `details.reason` (no key, the kill switch, …): to the author, those are
 * one thing, and the codes are not spelled here (a client chunk naming a
 * server variable fails the build's check).
 */
export function useInterviewErrorMessage(): (reason: string | null, status?: number) => string {
    const t = useTranslations('interview.errors');
    return useCallback(
        (reason: string | null, status?: number) => {
            if (reason && (INTERVIEW_WORDED_REASONS as readonly string[]).includes(reason)) return t(reason);
            if (status === 503) return t('AI_UNAVAILABLE');
            return t('generic');
        },
        [t],
    );
}
