'use client';

/**
 * Add one of the book's elements to the map (Phase 3.1): a search over the
 * book's elements by name (the bible's own list route and its clamped query),
 * one pick adding one node. Only the kinds the map draws are offered
 * (Phase 3.2: `MAP_ELEMENT_KINDS`; the save refuses any other). An element already on the map is marked, and
 * picking it brings it into view rather than drawing it twice.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { BIBLE_API, bibleFetch, type ElementListItemView } from '@/lib/bible/api-client';
import { pickerQuery } from '@/lib/bible/picker-query';

const PAGE = 20;
const DEBOUNCE_MS = 200;

export interface AddElementPickerProps {
    workspaceSlug: string;
    bookId: string;
    /** The kinds this map draws (Phase 3.2): the search offers no other. */
    kinds?: readonly string[];
    /** Element ids already on the map. */
    onMap: ReadonlySet<string>;
    kindLabels: Readonly<Record<string, string>>;
    onPick: (element: ElementListItemView) => void;
}

export function AddElementPicker({ workspaceSlug, bookId, kinds, onMap, kindLabels, onPick }: AddElementPickerProps) {
    const t = useTranslations('canvas.toolbar');
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const [items, setItems] = useState<ElementListItemView[]>([]);
    const [searching, setSearching] = useState(false);
    const [failed, setFailed] = useState(false);
    const seq = useRef(0);

    useEffect(() => {
        if (!open) return;
        const mine = ++seq.current;
        const timer = setTimeout(() => {
            setSearching(true);
            bibleFetch<{ elements: ElementListItemView[] }>(BIBLE_API.elements(workspaceSlug, bookId, { kinds, q: pickerQuery(query), take: PAGE }))
                .then(({ elements }) => {
                    if (mine !== seq.current) return;
                    setItems(elements);
                    setFailed(false);
                })
                .catch(() => {
                    if (mine === seq.current) setFailed(true);
                })
                .finally(() => {
                    if (mine === seq.current) setSearching(false);
                });
        }, DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [open, query, workspaceSlug, bookId, kinds]);

    const options: ComboboxOption<ElementListItemView>[] = items.map((e) => ({ value: e.id, label: e.name, meta: e }));

    return (
        <Combobox<undefined, ElementListItemView>
            id="map-add-element"
            options={options}
            selected={null}
            onSelect={(o) => {
                if (o.meta) onPick(o.meta);
                setOpen(false);
            }}
            open={open}
            onOpenChange={setOpen}
            onSearchChange={setQuery}
            shouldFilter={false}
            loading={searching}
            placeholder={t('addElement')}
            searchPlaceholder={t('addSearch')}
            emptyState={failed ? t('searchFailed') : t('noCandidates')}
            optionDescription={(o) => {
                const e = o.meta;
                if (!e) return undefined;
                const kind = e.customLabel ?? kindLabels[e.kind] ?? e.kind;
                return onMap.has(e.id) ? `${kind} · ${t('onMap')}` : kind;
            }}
        />
    );
}
