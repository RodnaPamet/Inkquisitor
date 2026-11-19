'use client';

/**
 * The bible's two exports, downloaded through `bibleDownload` (Phase 1.H,
 * #27): the file is saved only when the API answers with the file; a refusal
 * (`EXPORT_TOO_LARGE`, a 404, a network failure) is shown as a toast in the
 * page's words, never saved as the "export". Used by the board's export
 * buttons and the delete dialog's "export first".
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { BIBLE_API, bibleDownload, reasonOf } from '@/lib/bible/api-client';

export type ExportFormat = 'bundle' | 'pdf';

export function useExportDownload(workspaceSlug: string, bookId: string) {
    const t = useTranslations('bible.transfer');
    const [busy, setBusy] = useState<ExportFormat | null>(null);

    async function start(format: ExportFormat): Promise<boolean> {
        setBusy(format);
        try {
            const url = format === 'bundle' ? BIBLE_API.exportBundle(workspaceSlug, bookId) : BIBLE_API.exportPdf(workspaceSlug, bookId);
            await bibleDownload(url, format === 'bundle' ? 'bible.zip' : 'bible.pdf');
            return true;
        } catch (err) {
            const reason = reasonOf(err);
            toast.error(reason === 'EXPORT_TOO_LARGE' ? t('exportTooLarge') : t('exportFailed'));
            return false;
        } finally {
            setBusy(null);
        }
    }

    return { busy, start };
}
