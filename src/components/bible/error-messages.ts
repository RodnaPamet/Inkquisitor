'use client';

/**
 * A bible API refusal, worded for the author (Phase 1.2). The API names a
 * refusal by `details.reason` (`BibleApiError.reason`); the words come from
 * next-intl (`bible.errors`), never from the server's English message. A
 * reason this table does not know, and a network failure, read as the
 * generic message.
 */
import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

/** The reasons the bible UI words on its own. */
export const WORDED_REASONS = [
    'SLUG_TAKEN',
    'RELATION_EXISTS',
    'RELATION_TYPE_NOT_ALLOWED',
    'SELF_RELATION',
    'CUSTOM_LABEL_REQUIRED',
    'FIELD_VALUES_REFUSED',
    'EMPTY',
    'TOO_LONG',
    'KIND_MISMATCH',
] as const;

export function useApiErrorMessage(): (reason: string | null) => string {
    const t = useTranslations('bible.errors');
    return useCallback(
        (reason: string | null) => ((WORDED_REASONS as readonly string[]).includes(reason ?? '') ? t(reason as string) : t('generic')),
        [t],
    );
}
