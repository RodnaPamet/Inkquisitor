'use client';

/**
 * A bible import's refusals, worded for the author (Phase 1.3). The API names
 * every refusal by a reason code — the request's own (`details.reason`) and,
 * for a refused bundle, each problem's — and the words come from next-intl
 * (`bible.transfer.reasons`), never from the server's English. A reason this
 * table does not know reads as the generic message with its code, so a new
 * server reason is never shown as nothing.
 *
 * The list is `IMPORT_REASONS` (`src/lib/bible/import-reasons.ts`);
 * `tests/unit/bible/import-reasons.test.ts` holds it to the reasons the
 * server can name and to the catalogue.
 */
import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { IMPORT_REASONS } from '@/lib/bible/import-reasons';

export function useImportReasonMessage(): (reason: string | null) => string {
    const t = useTranslations('bible.transfer.reasons');
    return useCallback(
        (reason: string | null) => ((IMPORT_REASONS as readonly string[]).includes(reason ?? '') ? t(reason as string) : t('generic', { reason: reason ?? '' })),
        [t],
    );
}
