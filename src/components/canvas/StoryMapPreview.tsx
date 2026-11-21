'use client';

/**
 * A story map, read-only, embedded on a bible page (Phase 3.2): the
 * relationship map on a character's or faction's page, the plot board on a
 * plot beat's, the timeline on a timeline event's, with the page's own
 * element marked.
 *
 * A LIGHT SVG, NOT TLDRAW. The map's rows already say where every node sits
 * (the relationship map's stored positions; the derived maps' positions the
 * server worked out from the bible, `deriveLaneLayout`), so a picture needs no
 * editor: the element pages keep tldraw out of their first load, and out of
 * their chunks altogether (`scripts/check-build.js`). Every node is a link to
 * its element's page, so the picture is navigable by keyboard and named for a
 * screen reader; the "Open" link goes to the editable map.
 *
 * Read-only for everybody: a reader sees the same picture an editor does.
 */
import Link from 'next/link';
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { APP_ROUTES } from '@/lib/app-routes';
import type { StoryMapView } from '@/lib/canvas/api-client';
import { deriveLaneLayout, participantsByEvent } from '@/lib/canvas/lanes';
import { mapKindSlug, type StoryMapKindValue } from '@/lib/canvas/map-kinds';
import { truncateGraphemes } from '@/lib/text/truncate';

export interface StoryMapPreviewProps {
    workspaceSlug: string;
    bookId: string;
    mapKind: StoryMapKindValue;
    map: StoryMapView;
    /** The page's element, marked on the map. */
    currentElementId: string;
    kindLabels: Readonly<Record<string, string>>;
}

const PAD = 24;
const NAME_MAX = 26;

/** At most NAME_MAX characters, cut between grapheme clusters (an emoji is never split into a `�`). */
const short = (s: string) => truncateGraphemes(s, NAME_MAX);

export function StoryMapPreview({ workspaceSlug, bookId, mapKind, map, currentElementId, kindLabels }: StoryMapPreviewProps) {
    const t = useTranslations('canvas');
    const mapLabel = t(`kinds.${mapKind}`);
    const lanes = useMemo(() => {
        const participants = participantsByEvent(map.participants);
        return deriveLaneLayout(
            mapKind,
            map.nodes.map((n) => ({ elementId: n.elementId, name: n.element.name, orderRank: n.element.orderRank, act: n.element.act })),
            { acts: map.acts, participants, words: { noAct: t('lanes.noAct'), unplaced: t('lanes.unplaced'), axis: t('lanes.axis') } },
        );
    }, [map, mapKind, t]);

    const box = useMemo(() => {
        const xs: number[] = [];
        const ys: number[] = [];
        for (const n of map.nodes) {
            xs.push(n.x, n.x + n.w);
            ys.push(n.y, n.y + n.h);
        }
        for (const b of lanes?.bands ?? []) {
            xs.push(b.x, b.x + b.w);
            ys.push(b.y, b.y + b.h);
        }
        if (xs.length === 0) return null;
        const minX = Math.min(...xs) - PAD;
        const minY = Math.min(...ys) - PAD;
        return { x: minX, y: minY, w: Math.max(...xs) + PAD - minX, h: Math.max(...ys) + PAD - minY };
    }, [map, lanes]);

    const centre = new Map(map.nodes.map((n) => [n.elementId, { x: n.x + n.w / 2, y: n.y + n.h / 2 }]));
    const current = map.nodes.find((n) => n.elementId === currentElementId);
    const mapHref = APP_ROUTES.storyMap(workspaceSlug, bookId, mapKindSlug(mapKind));

    return (
        <section className="space-y-tight" aria-labelledby={`map-preview-${mapKind}`} data-testid={`map-preview-${mapKind}`}>
            <h3 id={`map-preview-${mapKind}`} className="text-sm font-semibold text-content-emphasis">
                {t('preview.title', { map: mapLabel })}
            </h3>
            {box === null ? (
                <p className="text-xs text-content-muted">{t('preview.empty', { map: mapLabel })}</p>
            ) : (
                <>
                    {current ? null : <p className="text-xs text-content-muted">{t('preview.notOnMap', { map: mapLabel })}</p>}
                    <svg
                        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
                        className="block max-h-80 w-full rounded-md border border-border-subtle bg-bg-default"
                        role="group"
                        aria-label={t('preview.label', { map: mapLabel, name: current?.element.name ?? '' })}
                        data-map-preview={mapKind}
                    >
                        {(lanes?.bands ?? []).map((b) => (
                            <g key={b.key} aria-hidden="true">
                                <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={6} className="fill-[var(--bg-subtle)] stroke-[var(--border-subtle)]" />
                                <text x={b.role === 'character' ? b.x + 8 : b.x + 12} y={b.role === 'character' ? b.y + b.h / 2 + 5 : b.y + 22} className="fill-[var(--content-muted)] text-[14px]">
                                    {short(b.label)}
                                </text>
                            </g>
                        ))}
                        {map.edges.map((e) => {
                            const a = centre.get(e.sourceElementId);
                            const b = centre.get(e.targetElementId);
                            if (!a || !b) return null;
                            return (
                                <line key={e.relationId} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="stroke-[var(--border-strong)]" strokeWidth={2} aria-hidden="true">
                                    <title>{e.label}</title>
                                </line>
                            );
                        })}
                        {(lanes?.marks ?? []).map((m) => (
                            <circle key={`${m.characterId}:${m.elementId}`} cx={m.x} cy={m.y} r={6} className="fill-[var(--brand-default)]" aria-hidden="true" />
                        ))}
                        {map.nodes.map((n) => {
                            const isCurrent = n.elementId === currentElementId;
                            const kind = n.element.customLabel ?? kindLabels[n.element.kind] ?? n.element.kind;
                            return (
                                <a
                                    key={n.elementId}
                                    href={APP_ROUTES.bibleElement(workspaceSlug, bookId, n.elementId)}
                                    aria-current={isCurrent ? 'true' : undefined}
                                    data-preview-node={n.elementId}
                                    data-current={isCurrent ? 'true' : undefined}
                                >
                                    {/* The link's name is its text as shown (name, then kind): axe's label-in-name. */}
                                    <rect
                                        x={n.x}
                                        y={n.y}
                                        width={n.w}
                                        height={n.h}
                                        rx={6}
                                        className={isCurrent ? 'fill-[var(--bg-muted)] stroke-[var(--brand-default)]' : 'fill-[var(--bg-default)] stroke-[var(--border-default)]'}
                                        strokeWidth={isCurrent ? 4 : 1.5}
                                    />
                                    <text x={n.x + 12} y={n.y + 28} className="fill-[var(--content-emphasis)] text-[16px] font-medium">
                                        {short(n.element.name)}
                                    </text>
                                    <text x={n.x + 12} y={n.y + 52} className="fill-[var(--content-muted)] text-[13px]">
                                        {short(kind)}
                                    </text>
                                </a>
                            );
                        })}
                    </svg>
                </>
            )}
            <Link href={mapHref} className="inline-block text-xs font-medium text-content-brand underline-offset-2 hover:underline" data-testid={`map-preview-open-${mapKind}`}>
                {t('preview.open', { map: mapLabel })}
            </Link>
        </section>
    );
}
