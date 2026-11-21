'use client';

/**
 * The story map as a LIST (Phase 3.H, item 5): every canvas action, by
 * keyboard and screen reader.
 *
 * The canvas is a picture you point at; this is the same map as headings,
 * lists and buttons, in reading order. It acts through the SAME editor and
 * the same handlers as the canvas (the host, `StoryMapEditor`, passes them),
 * so an action here is the action there — saved by the same autosave, under
 * the same version lock, into the same rows:
 *
 *   canvas                              list
 *   ─────────────────────────────────── ──────────────────────────────────────
 *   add a node (picker)                 the toolbar's picker (already a combobox)
 *   double-click a node                 the element's name: a button that opens it
 *   delete a node                       "Remove from map"
 *   drag a card to another place        "Earlier" / "Later" (a derived map's order)
 *   draw an arrow between two nodes     "Relate": two choices, then the type picker
 *   delete an edge's line               "Remove relation" (the same undo toast)
 *   select, then "Grill this"           a checkbox per element and relation, then "Grill the selected"
 *   select an edge, "Question this…"    "Question this relation" on its row
 *   the gap between two beats           the toolbar's "What happens between…" picker
 *   accept a ghost                      the pending list beside the map (the record)
 *   restore a snapshot, export          History and Export in the toolbar
 *
 * No tldraw here: plain data in, callbacks out, so it renders and is tested
 * without an editor. Element names and relation labels are author text,
 * rendered as React text.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { SELECTION_QUERY_MAX } from '@/lib/interview/setup';
import type { CanvasSelection } from './CanvasInterviewControls';

export interface ListNode {
    elementId: string;
    name: string;
    kindLabel: string;
    badgeLabel: string;
    /** A second line: an event's time, "not placed yet"; '' for none. */
    detail: string;
}

export interface ListEdge {
    relationId: string;
    sourceElementId: string;
    targetElementId: string;
    label: string;
}

/** A derived map's lane, its cards in the order shown (an act, the axis, "not placed yet"). */
export interface ListGroup {
    key: string;
    label: string;
    elementIds: readonly string[];
}

export interface StoryMapListViewProps {
    nodes: readonly ListNode[];
    edges: readonly ListEdge[];
    /** The derived maps' lanes in order; null on the relationship map (free positions have no reading order). */
    groups: readonly ListGroup[] | null;
    canEdit: boolean;
    onOpen: (elementId: string) => void;
    onRemoveNode: (elementId: string) => void;
    onRemoveEdge: (edge: ListEdge) => void;
    onRelate: (fromElementId: string, toElementId: string) => void;
    onGrill: (selection: CanvasSelection) => void;
    /** A derived map's order moves; absent on the relationship map. */
    canMove?: (elementId: string, direction: 'earlier' | 'later') => boolean;
    onMove?: (elementId: string, direction: 'earlier' | 'later') => void;
}

export function StoryMapListView({ nodes, edges, groups, canEdit, onOpen, onRemoveNode, onRemoveEdge, onRelate, onGrill, canMove, onMove }: StoryMapListViewProps) {
    const t = useTranslations('canvas.list');
    const tInterview = useTranslations('canvas.interview');
    const byId = useMemo(() => new Map(nodes.map((n) => [n.elementId, n])), [nodes]);
    const [picked, setPicked] = useState<{ elements: ReadonlySet<string>; relations: ReadonlySet<string> }>({ elements: new Set(), relations: new Set() });
    const [from, setFrom] = useState<string | null>(null);
    const [to, setTo] = useState<string | null>(null);

    // Only what is still on the map counts as picked.
    const selection: CanvasSelection = useMemo(
        () => ({ elementIds: [...picked.elements].filter((id) => byId.has(id)), relationIds: [...picked.relations].filter((id) => edges.some((e) => e.relationId === id)) }),
        [picked, byId, edges],
    );
    const count = selection.elementIds.length + selection.relationIds.length;
    const tooLarge = selection.elementIds.length > SELECTION_QUERY_MAX || selection.relationIds.length > SELECTION_QUERY_MAX;
    const toggle = (kind: 'elements' | 'relations', id: string, on: boolean) =>
        setPicked((prev) => {
            const next = new Set(prev[kind]);
            if (on) next.add(id);
            else next.delete(id);
            return { ...prev, [kind]: next };
        });

    const options: ComboboxOption<undefined>[] = useMemo(
        () => [...nodes].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((n) => ({ value: n.elementId, label: n.name })),
        [nodes],
    );
    const ordered: Array<{ group: ListGroup | null; nodes: ListNode[] }> = useMemo(() => {
        if (!groups) return [{ group: null, nodes: [...nodes].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) }];
        return groups.map((g) => ({ group: g, nodes: g.elementIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])) }));
    }, [groups, nodes, byId]);

    const nameOf = (id: string) => byId.get(id)?.name ?? '';

    return (
        <div className="flex flex-col gap-section p-default" data-testid="map-list-view">
            <section aria-labelledby="map-list-elements" className="flex flex-col gap-default">
                <h2 id="map-list-elements" className="text-base font-semibold text-content-emphasis">
                    {t('elements', { count: nodes.length })}
                </h2>
                {nodes.length === 0 ? <p className="text-sm text-content-muted">{t('noElements')}</p> : null}
                {ordered.map(({ group, nodes: inGroup }) => (
                    <div key={group?.key ?? 'all'} className="flex flex-col gap-tight">
                        {group ? (
                            <h3 className="text-sm font-medium text-content-emphasis" id={`map-list-group-${group.key}`}>
                                {group.label}
                            </h3>
                        ) : null}
                        {group && inGroup.length === 0 ? <p className="text-xs text-content-muted">{t('emptyGroup')}</p> : null}
                        <ol className="flex flex-col gap-tight" aria-labelledby={group ? `map-list-group-${group.key}` : 'map-list-elements'}>
                            {inGroup.map((n, index) => (
                                <li key={n.elementId} className="flex flex-wrap items-center gap-tight rounded-md border border-border-subtle p-compact" data-testid="map-list-element" data-element-id={n.elementId}>
                                    {canEdit ? (
                                        <Checkbox
                                            checked={picked.elements.has(n.elementId)}
                                            onCheckedChange={(v) => toggle('elements', n.elementId, v === true)}
                                            aria-label={t('pickElement', { name: n.name })}
                                        />
                                    ) : null}
                                    <Button variant="ghost" size="sm" onClick={() => onOpen(n.elementId)} aria-label={t('open', { name: n.name })} data-testid="map-list-open">
                                        {n.name}
                                    </Button>
                                    <span className="text-xs text-content-muted">
                                        {n.kindLabel}
                                        {n.badgeLabel ? ` · ${n.badgeLabel}` : ''}
                                        {n.detail ? ` · ${n.detail}` : ''}
                                        {group ? ` · ${t('position', { position: index + 1, of: inGroup.length })}` : ''}
                                    </span>
                                    {canEdit ? (
                                        <span className="ml-auto flex items-center gap-tight">
                                            {onMove && canMove ? (
                                                <>
                                                    <Button variant="secondary" size="xs" disabled={!canMove(n.elementId, 'earlier')} onClick={() => onMove(n.elementId, 'earlier')} aria-label={t('earlier', { name: n.name })}>
                                                        {t('earlierShort')}
                                                    </Button>
                                                    <Button variant="secondary" size="xs" disabled={!canMove(n.elementId, 'later')} onClick={() => onMove(n.elementId, 'later')} aria-label={t('later', { name: n.name })}>
                                                        {t('laterShort')}
                                                    </Button>
                                                </>
                                            ) : null}
                                            <Button variant="secondary" size="xs" onClick={() => onRemoveNode(n.elementId)} aria-label={t('removeNode', { name: n.name })} data-testid="map-list-remove-node">
                                                {t('removeNodeShort')}
                                            </Button>
                                        </span>
                                    ) : null}
                                </li>
                            ))}
                        </ol>
                    </div>
                ))}
            </section>

            <section aria-labelledby="map-list-relations" className="flex flex-col gap-default">
                <h2 id="map-list-relations" className="text-base font-semibold text-content-emphasis">
                    {t('relations', { count: edges.length })}
                </h2>
                {edges.length === 0 ? <p className="text-sm text-content-muted">{t('noRelations')}</p> : null}
                <ul className="flex flex-col gap-tight" aria-labelledby="map-list-relations">
                    {edges.map((e) => {
                        const sentence = t('relation', { a: nameOf(e.sourceElementId), label: e.label, b: nameOf(e.targetElementId) });
                        return (
                            <li key={e.relationId} className="flex flex-wrap items-center gap-tight rounded-md border border-border-subtle p-compact" data-testid="map-list-relation" data-relation-id={e.relationId}>
                                {canEdit ? (
                                    <Checkbox checked={picked.relations.has(e.relationId)} onCheckedChange={(v) => toggle('relations', e.relationId, v === true)} aria-label={t('pickRelation', { relation: sentence })} />
                                ) : null}
                                <span className="text-sm text-content-default">{sentence}</span>
                                {canEdit ? (
                                    <span className="ml-auto flex items-center gap-tight">
                                        <Button variant="secondary" size="xs" onClick={() => onGrill({ elementIds: [], relationIds: [e.relationId] })} aria-label={t('question', { relation: sentence })} data-testid="map-list-question">
                                            {tInterview('questionRelation')}
                                        </Button>
                                        <Button variant="secondary" size="xs" onClick={() => onRemoveEdge(e)} aria-label={t('removeEdge', { relation: sentence })} data-testid="map-list-remove-edge">
                                            {t('removeEdgeShort')}
                                        </Button>
                                    </span>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            </section>

            {canEdit ? (
                <section aria-labelledby="map-list-actions" className="flex flex-col gap-default">
                    <h2 id="map-list-actions" className="text-base font-semibold text-content-emphasis">
                        {t('actions')}
                    </h2>
                    <div className="flex flex-wrap items-end gap-tight" role="group" aria-label={t('relateGroup')}>
                        <Combobox<undefined, undefined> id="map-list-relate-from" options={options} selected={options.find((o) => o.value === from) ?? null} onSelect={(o) => setFrom(o.value)} placeholder={t('relateFrom')} searchPlaceholder={t('relateSearch')} emptyState={t('relateNone')} />
                        <Combobox<undefined, undefined> id="map-list-relate-to" options={options} selected={options.find((o) => o.value === to) ?? null} onSelect={(o) => setTo(o.value)} placeholder={t('relateTo')} searchPlaceholder={t('relateSearch')} emptyState={t('relateNone')} />
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={!from || !to || from === to}
                            disabledTooltip={from && to && from === to ? t('relateSame') : undefined}
                            onClick={() => {
                                if (from && to && from !== to) onRelate(from, to);
                            }}
                            data-testid="map-list-relate"
                        >
                            {t('relate')}
                        </Button>
                    </div>
                    <div>
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={count === 0 || tooLarge}
                            disabledTooltip={count === 0 ? t('pickFirst') : tooLarge ? tInterview('tooMany', { max: SELECTION_QUERY_MAX }) : undefined}
                            onClick={() => onGrill(selection)}
                            data-testid="map-list-grill"
                        >
                            {t('grillSelected', { count })}
                        </Button>
                    </div>
                </section>
            ) : null}
        </div>
    );
}
