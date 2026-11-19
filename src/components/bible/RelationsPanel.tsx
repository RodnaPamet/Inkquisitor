'use client';

/**
 * An element's relations (Phase 1.2): every relation it takes part in, read
 * from its own end (the API gives each one's label for this end: the type's
 * label when this element started it, the inverse label when it ends here),
 * and, for an author who may edit, a picker to add one and a remove button
 * that follows the undo-toast convention.
 *
 * The picker is two `<Combobox>`es: the relation (only the types valid for
 * this element's kind, from either end — `relationOptionsFor`), then the
 * other element (only the book's elements of a kind that relation allows,
 * never this element). The other element is SEARCHED on the server as the
 * author types (Phase 1.H, #18: `listElements` with `kinds` and `q`, a page of
 * `PICKER_PAGE`), so a book of any size is reachable and the page never reads
 * every element. A relation another kind declares towards this one is
 * stored from the other element, so its request names the other element as
 * `from`.
 *
 * An add whose re-read fails is still an add (#20): the relation exists, so
 * the re-read is tried again, and if that fails too the panel says the list
 * may be stale — never that the add failed, which a retry would answer
 * RELATION_EXISTS.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { useToastWithUndo } from '@/components/ui/hooks';
import { APP_ROUTES } from '@/lib/app-routes';
import { BIBLE_API, bibleFetch, reasonOf, type ElementView } from '@/lib/bible/api-client';
import type { BibleKind } from '@/lib/bible/kinds';
import type { RelationOption } from '@/lib/bible/ui-model';
import { useApiErrorMessage } from './error-messages';

/** Matches the picker shows at most per search. */
export const PICKER_PAGE = 20;
/** The pause after a keystroke before the picker searches. */
const SEARCH_DEBOUNCE_MS = 200;

export interface RelationsPanelProps {
    workspaceSlug: string;
    bookId: string;
    element: Pick<ElementView, 'id' | 'kind' | 'relations'>;
    options: RelationOption[];
    kindLabels: Record<BibleKind, string>;
    canEdit: boolean;
    /** Re-read the element (its relations) after a change. */
    onChanged: () => Promise<void>;
}

export function RelationsPanel({ workspaceSlug, bookId, element, options, kindLabels, canEdit, onChanged }: RelationsPanelProps) {
    const t = useTranslations('bible.relations');
    const errorMessage = useApiErrorMessage();
    const triggerUndo = useToastWithUndo();
    const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
    const [typeId, setTypeId] = useState<string | null>(null);
    const [other, setOther] = useState<ComboboxOption | null>(null);
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [candidates, setCandidates] = useState<ComboboxOption[]>([]);
    const [searching, setSearching] = useState(false);
    const [searchFailed, setSearchFailed] = useState(false);
    const searchSeq = useRef(0);

    const relationOptions: ComboboxOption[] = options.map((o) => ({
        value: o.id,
        label: o.label,
    }));
    // Two relation types can read the same from this end (a CHARACTER
    // "opposes" a character or faction, and "opposes" a plot as the inverse
    // of the plot's own type). Each such option names the kinds it reaches,
    // so the author can tell them apart.
    const sharedLabels = useMemo(() => {
        const seen = new Set<string>();
        const shared = new Set<string>();
        for (const o of options) (seen.has(o.label) ? shared : seen).add(o.label);
        return shared;
    }, [options]);
    const describeType = (o: ComboboxOption) => {
        const opt = options.find((x) => x.id === o.value);
        return opt && sharedLabels.has(opt.label) ? opt.otherKinds.map((k) => kindLabels[k]).join(', ') : undefined;
    };
    const option = options.find((o) => o.id === typeId) ?? null;
    const kindsKey = option ? option.otherKinds.join(',') : '';

    // Search the book for elements the chosen relation can reach, as the author types.
    useEffect(() => {
        if (!kindsKey) return;
        const seq = ++searchSeq.current;
        const timer = setTimeout(() => {
            setSearching(true);
            bibleFetch<{ elements: Array<{ id: string; name: string; kind: BibleKind }> }>(
                BIBLE_API.elements(workspaceSlug, bookId, { kinds: kindsKey.split(','), q: query.trim() || undefined, take: PICKER_PAGE + 1 }),
            )
                .then(({ elements }) => {
                    if (seq !== searchSeq.current) return;
                    setCandidates(
                        elements
                            .filter((e) => e.id !== element.id)
                            .slice(0, PICKER_PAGE)
                            .map((e) => ({ value: e.id, label: e.name, meta: e.kind })),
                    );
                    setSearchFailed(false);
                })
                .catch(() => {
                    if (seq === searchSeq.current) setSearchFailed(true);
                })
                .finally(() => {
                    if (seq === searchSeq.current) setSearching(false);
                });
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [kindsKey, query, workspaceSlug, bookId, element.id]);

    const visible = element.relations.filter((r) => !hidden.has(r.id));

    async function add() {
        if (!option || !other) return;
        setAdding(true);
        setError(null);
        setNotice(null);
        const [fromElementId, toElementId] = option.direction === 'outgoing' ? [element.id, other.value] : [other.value, element.id];
        try {
            await bibleFetch(BIBLE_API.relations(workspaceSlug, bookId), { method: 'POST', body: { fromElementId, toElementId, type: option.type } });
        } catch (err) {
            setError(errorMessage(reasonOf(err)));
            setAdding(false);
            return;
        }
        // The relation exists now, whatever the re-read does.
        setOther(null);
        try {
            await onChanged();
        } catch {
            try {
                await onChanged();
            } catch {
                setNotice(t('addedNotShown'));
            }
        } finally {
            setAdding(false);
        }
    }

    function remove(relationId: string, label: string, otherName: string) {
        setHidden((h) => new Set(h).add(relationId));
        const unhide = () =>
            setHidden((h) => {
                const next = new Set(h);
                next.delete(relationId);
                return next;
            });
        triggerUndo({
            message: t('removed', { label, name: otherName }),
            undoMessage: t('undo'),
            action: () => bibleFetch(BIBLE_API.relation(workspaceSlug, bookId, relationId), { method: 'DELETE' }),
            undoAction: unhide,
            onCommit: () => {
                // Deleted: the row stays hidden until the re-read drops it, and
                // stays hidden if the re-read fails (it would show a relation
                // that no longer exists).
                void onChanged().then(unhide, () => undefined);
            },
            onError: () => {
                unhide();
                toast.error(t('removeFailed'));
            },
        });
    }

    return (
        <Card className="space-y-default p-5" data-testid="relations-panel">
            <h2 className="text-base font-semibold text-content-emphasis">{t('title')}</h2>
            {visible.length === 0 ? (
                <p className="text-sm text-content-muted">{t('none')}</p>
            ) : (
                <ul className="divide-y divide-[var(--border-subtle)]" aria-label={t('title')}>
                    {visible.map((r) => (
                        <li key={r.id} className="flex items-center justify-between gap-tight py-2" data-relation-id={r.id}>
                            <p className="min-w-0 text-sm text-content-default">
                                <span className="text-content-muted">{r.label}</span>{' '}
                                <Link href={APP_ROUTES.bibleElement(workspaceSlug, bookId, r.other.id)} className="font-medium text-content-emphasis hover:underline">
                                    {r.other.name}
                                </Link>{' '}
                                <span className="text-xs text-content-muted">({kindLabels[r.other.kind]})</span>
                            </p>
                            {canEdit ? (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    icon={<X className="size-3.5" aria-hidden="true" />}
                                    aria-label={t('remove', { label: r.label, name: r.other.name })}
                                    onClick={() => remove(r.id, r.label, r.other.name)}
                                />
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}
            {canEdit ? (
                <div className="space-y-default border-t border-border-subtle pt-default" data-testid="relation-picker">
                    <FormField label={t('type')}>
                        <Combobox
                            id="relation-type"
                            options={relationOptions}
                            selected={relationOptions.find((o) => o.value === typeId) ?? null}
                            setSelected={(o) => {
                                setTypeId(o ? o.value : null);
                                setOther(null);
                                setCandidates([]);
                                setQuery('');
                            }}
                            placeholder={t('typePlaceholder')}
                            searchPlaceholder={t('typeSearch')}
                            optionDescription={describeType}
                            matchTriggerWidth
                        />
                    </FormField>
                    <FormField label={t('other')}>
                        <Combobox
                            id="relation-other"
                            options={candidates}
                            selected={other}
                            setSelected={(o) => setOther(o)}
                            onSearchChange={setQuery}
                            shouldFilter={false}
                            loading={searching}
                            placeholder={option ? t('otherPlaceholder') : t('otherNeedsType')}
                            searchPlaceholder={t('otherSearch')}
                            emptyState={searchFailed ? t('searchFailed') : t('noCandidates')}
                            optionDescription={(o) => kindLabels[o.meta as BibleKind]}
                            disabled={!option}
                            matchTriggerWidth
                        />
                    </FormField>
                    {error ? (
                        <p className="text-sm text-content-error" role="alert">
                            {error}
                        </p>
                    ) : null}
                    {notice ? (
                        <p className="text-sm text-content-muted" role="status">
                            {notice}
                        </p>
                    ) : null}
                    <Button
                        variant="secondary"
                        icon={<Link2 className="size-4" aria-hidden="true" />}
                        onClick={() => void add()}
                        disabled={!option || !other}
                        loading={adding}
                        id="relation-add"
                    >
                        {t('add')}
                    </Button>
                </div>
            ) : null}
        </Card>
    );
}
