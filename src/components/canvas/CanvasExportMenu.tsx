'use client';

/**
 * The story canvas's export menu: the current page as PNG or SVG, downloaded
 * in the browser.
 *
 * Carved from inflect-compliance's `TldrawCanvasExportMenu.tsx`
 * (docs/carve-manifest.md), without the server-backed PDF and evidence
 * items and the clipboard copy. The trigger is disabled until the editor is
 * mounted; a failure is a toast, worded from its kind, never the error.
 */
import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Editor } from 'tldraw';

import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/hooks';
import { Popover } from '@/components/ui/popover';
import { EmptyCanvasExportError, exportCanvasAsPng, exportCanvasAsSvg } from '@/lib/canvas/canvas-export';

export interface CanvasExportMenuProps {
    editor: Editor | null;
    /** The download's name stem (the book and the map). */
    fileStem: string;
}

export function CanvasExportMenu({ editor, fileStem }: CanvasExportMenuProps) {
    const t = useTranslations('canvas.export');
    const toast = useToast();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);

    const run = useCallback(
        async (format: 'png' | 'svg') => {
            if (!editor) return;
            setBusy(true);
            try {
                await (format === 'png' ? exportCanvasAsPng : exportCanvasAsSvg)({ editor, fileStem });
                setOpen(false);
            } catch (err) {
                toast.error(err instanceof EmptyCanvasExportError ? t('empty') : t('failed'));
            } finally {
                setBusy(false);
            }
        },
        [editor, fileStem, toast, t],
    );

    return (
        <Popover
            openPopover={open}
            setOpenPopover={setOpen}
            content={
                <Popover.Menu aria-label={t('menu')}>
                    <Popover.Item data-testid="canvas-export-png" onClick={() => void run('png')} disabled={busy}>
                        {t('png')}
                    </Popover.Item>
                    <Popover.Item data-testid="canvas-export-svg" onClick={() => void run('svg')} disabled={busy}>
                        {t('svg')}
                    </Popover.Item>
                </Popover.Menu>
            }
        >
            <Button variant="secondary" size="sm" disabled={busy || !editor} data-testid="canvas-export-trigger" aria-haspopup="menu">
                {busy ? t('exporting') : t('trigger')}
            </Button>
        </Popover>
    );
}
