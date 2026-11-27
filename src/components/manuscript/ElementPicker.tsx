'use client';

/**
 * A searched picker of the book's elements of some kinds (Phase 5.1): a scene's
 * point of view (characters), setting (settings), plot beats and linked
 * elements. The element list is searched on the server as the author types
 * (the relation picker's clamped `q`, a page at a time), so a book of any size
 * is reachable and nothing reads every element.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { BIBLE_API, bibleFetch, type ElementPageView } from '@/lib/bible/api-client';
import type { BibleKind } from '@/lib/bible/kinds';
import { pickerQuery } from '@/lib/bible/picker-query';

const PICKER_PAGE = 20;
const SEARCH_DEBOUNCE_MS = 200;

export interface ElementPickerProps {
    id: string;
    workspaceSlug: string;
    bookId: string;
    kinds: readonly BibleKind[];
    selected: { id: string; name: string } | null;
    onSelect: (element: { id: string; name: string; kind: string } | null) => void;
    placeholder: string;
    kindLabel?: (kind: string) => string;
    disabled?: boolean;
    /** Ids not offered (already chosen). */
    exclude?: ReadonlySet<string>;
}

export function ElementPicker({ id, workspaceSlug, bookId, kinds, selected, onSelect, placeholder, kindLabel, disabled, exclude }: ElementPickerProps) {
    const t = useTranslations('manuscript.picker');
    const [query, setQuery] = useState('');
    const [options, setOptions] = useState<ComboboxOption<string>[]>([]);
    const [loading, setLoading] = useState(false);
    const [failed, setFailed] = useState(false);
    const seq = useRef(0);
    const kindsKey = kinds.join(',');

    useEffect(() => {
        const mine = ++seq.current;
        const timer = setTimeout(() => {
            setLoading(true);
            bibleFetch<ElementPageView>(BIBLE_API.elements(workspaceSlug, bookId, { kinds: kindsKey.split(','), q: pickerQuery(query), take: PICKER_PAGE }))
                .then((page) => {
                    if (mine !== seq.current) return;
                    setOptions(page.elements.filter((e) => !exclude?.has(e.id)).map((e) => ({ value: e.id, label: e.name, meta: e.kind })));
                    setFailed(false);
                })
                .catch(() => {
                    if (mine === seq.current) setFailed(true);
                })
                .finally(() => {
                    if (mine === seq.current) setLoading(false);
                });
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query, workspaceSlug, bookId, kindsKey, exclude]);

    const current: ComboboxOption<string> | null = selected ? { value: selected.id, label: selected.name } : null;
    return (
        <Combobox<false, string>
            id={id}
            options={options}
            selected={current}
            setSelected={(o) => onSelect(o ? { id: o.value, name: typeof o.label === 'string' ? o.label : '', kind: o.meta ?? '' } : null)}
            onSearchChange={setQuery}
            shouldFilter={false}
            loading={loading}
            placeholder={placeholder}
            searchPlaceholder={t('search')}
            emptyState={failed ? t('failed') : t('none')}
            optionDescription={kindLabel ? (o) => kindLabel(o.meta ?? '') : undefined}
            disabled={disabled}
            matchTriggerWidth
        />
    );
}
