'use client';

/**
 * Where an interview starts from a story map (Phase 3.3, D24), in the map's
 * toolbar; each opens the ordinary setup sheet (`InterviewSetupSheet`, through
 * `src/lib/interview/setup.ts`, the one seam) with a canvas target:
 *
 *   "Grill this"        the cards and edges selected: a SELECTION session over
 *                       those elements, the relations selected and every
 *                       relation between two selected elements. An edge alone
 *                       reads "Question this relation" — a session scoped to
 *                       that relation.
 *   "What happens       on the plot board: two neighbouring beats of one act;
 *    between…"          a BETWEEN session about the beat that does not exist
 *                       yet. The same slots stand on the canvas, in the gap
 *                       between the two cards (`GhostLayer`); this picker is
 *                       the keyboard's way to them.
 *
 * Rendered only for an editor (`bible.edit`), decided by the page.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useValue, type Editor } from 'tldraw';

import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { SELECTION_QUERY_MAX } from '@/lib/interview/setup';
import type { BetweenSlot } from '@/lib/canvas/structure-preview';
import { STORY_EDGE_SHAPE_TYPE } from './tldraw/story-edge-shape';
import { STORY_NODE_SHAPE_TYPE } from './tldraw/story-node-shape';

export interface CanvasSelection {
    elementIds: string[];
    relationIds: string[];
}

/** The story cards and edges selected now, read reactively (a stable key, so a re-render follows only a selection change). */
export function useCanvasSelection(editor: Editor | null): CanvasSelection {
    const key = useValue(
        'story-selection',
        () => {
            if (!editor) return '';
            const parts: string[] = [];
            for (const s of editor.getSelectedShapes()) {
                if (s.type === STORY_NODE_SHAPE_TYPE) parts.push(`e:${(s.props as { elementId: string }).elementId}`);
                else if (s.type === STORY_EDGE_SHAPE_TYPE) parts.push(`r:${(s.props as { relationId: string }).relationId}`);
            }
            return parts.sort().join(',');
        },
        [editor],
    );
    return useMemo(() => {
        const parts = key ? key.split(',') : [];
        return { elementIds: parts.filter((p) => p.startsWith('e:')).map((p) => p.slice(2)), relationIds: parts.filter((p) => p.startsWith('r:')).map((p) => p.slice(2)) };
    }, [key]);
}

export function GrillThisButton({ selection, onGrill }: { selection: CanvasSelection; onGrill: (selection: CanvasSelection) => void }) {
    const t = useTranslations('canvas.interview');
    const count = selection.elementIds.length + selection.relationIds.length;
    const tooLarge = selection.elementIds.length > SELECTION_QUERY_MAX || selection.relationIds.length > SELECTION_QUERY_MAX;
    const edgeOnly = selection.elementIds.length === 0 && selection.relationIds.length === 1;
    return (
        <Button
            variant="secondary"
            size="sm"
            disabled={count === 0 || tooLarge}
            disabledTooltip={count === 0 ? t('selectFirst') : tooLarge ? t('tooMany', { max: SELECTION_QUERY_MAX }) : undefined}
            onClick={() => onGrill(selection)}
            data-testid="map-grill-this"
            data-selected={count}
        >
            {edgeOnly ? t('questionRelation') : t('grillThis')}
        </Button>
    );
}

export function BetweenPicker({ slots, onPick }: { slots: readonly BetweenSlot[]; onPick: (slot: BetweenSlot) => void }) {
    const t = useTranslations('canvas.interview');
    const options: ComboboxOption<BetweenSlot>[] = useMemo(
        () => slots.map((s) => ({ value: `${s.afterElementId}:${s.beforeElementId}`, label: t('betweenOption', { a: s.afterName, b: s.beforeName }), meta: s })),
        [slots, t],
    );
    return (
        <Combobox<undefined, BetweenSlot>
            id="map-between"
            options={options}
            selected={null}
            onSelect={(o) => {
                if (o.meta) onPick(o.meta);
            }}
            placeholder={t('between')}
            searchPlaceholder={t('betweenSearch')}
            emptyState={t('betweenNone')}
        />
    );
}
