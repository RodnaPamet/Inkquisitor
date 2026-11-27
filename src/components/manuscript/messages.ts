'use client';

/**
 * A manuscript refusal in words (Phase 5.1): from its `details.reason`, through
 * `manuscript.reasons`, never the server's English message. A reason the table
 * does not know (or a network failure) reads as the generic failure.
 */
import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { MANUSCRIPT_REASONS } from '@/lib/manuscript/vocabulary';

export function useManuscriptReason(): (reason: string | null) => string {
    const t = useTranslations('manuscript.reasons');
    return useCallback((reason: string | null) => (reason && (MANUSCRIPT_REASONS as readonly string[]).includes(reason) ? t(reason) : t('UNKNOWN')), [t]);
}
