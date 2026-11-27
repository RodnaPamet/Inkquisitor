'use client';

/**
 * The plot board's SCENE CARDS (Phase 5.1, D33 addendum item B, owner decision
 * 2026-11-27): the manuscript scenes that dramatise each beat, drawn on the
 * board itself as small read-only cards along the bottom edge of the beat's
 * card — at most `BOARD_SCENES_PER_BEAT` a beat, and a "+N more" card that
 * opens the beat (its sheet lists them all).
 *
 * LIKE 3.3'S GHOSTS, NEVER A STORE RECORD. The cards are drawn by tldraw's
 * `Overlays` component (page space, above the shapes, so the derived layout is
 * left exactly as it is — they sit across the edge of the beat's card and the
 * lane's gap, never over another beat) from React state the host hands down
 * (`SceneCardsContext`, built from the map view's `beatScenes`, display data).
 * Nothing here creates, updates or deletes a record: the cards are not
 * serialised, not saved, not in a snapshot, cannot be selected or moved, and
 * never mark the map dirty — `tldrawToRows(rowsToTldraw(rows))` and every save
 * are unchanged by them (`tests/rendered/canvas-scene-cards.test.tsx`).
 *
 * Each card is a link to the scene's editor: focusable, opened by a click or
 * Enter, its pointer events kept from tldraw (so a click is not a selection).
 * They sit inside their own error boundary (`GhostBoundary`): if they cannot be
 * drawn they draw nothing, and the board, the sheet's list and the list view's
 * — the record of the same links — go on working. Scene and chapter titles are
 * author text, rendered as React text.
 */
import { createContext, useContext, useMemo, type MouseEvent } from 'react';
import { stopEventPropagation } from 'tldraw';

import type { BoardBeatScenes } from '@/lib/canvas/api-client';
import { BOARD_SCENES_PER_BEAT } from '@/lib/canvas/limits';
import { GhostBoundary, useNodeBoxes } from './GhostLayer';

export interface SceneCardsValue {
    /** Each beat's scenes (the first few in manuscript order, and how many in all), by the beat's element id. */
    beats: ReadonlyMap<string, BoardBeatScenes>;
    /** The scene's editor (the card's link). */
    href: (sceneId: string) => string;
    /** Open a scene in the app (a plain click); a modified click follows the link. */
    onOpenScene: (sceneId: string) => void;
    /** "+N more": open the beat, whose sheet lists every scene. */
    onOpenBeat: (beatElementId: string) => void;
    words: {
        untitled: string;
        /** The card's accessible name: "Open scene: <title>". */
        open: (title: string) => string;
        /** The "+N more" card's text and accessible name. */
        more: (count: number) => string;
        moreAria: (count: number) => string;
    };
}

export const SceneCardsContext = createContext<SceneCardsValue | null>(null);

/** A scene card's height, page units: it straddles the beat card's bottom edge, half inside, half in the lane's gap. */
export const SCENE_CARD_H = 20;
const INSET = 8;
const GAP = 4;
const MORE_W = 44;

export interface SceneCardBox {
    key: string;
    kind: 'scene' | 'more';
    beatElementId: string;
    sceneId: string | null;
    x: number;
    y: number;
    w: number;
}

/**
 * Where a beat's cards go (pure): one row along the bottom edge of the beat's
 * box, inside its width — so they never reach another beat's card or lane.
 */
export function sceneCardBoxes(box: { x: number; y: number; w: number; h: number }, beat: BoardBeatScenes): SceneCardBox[] {
    const shown = beat.scenes.slice(0, BOARD_SCENES_PER_BEAT);
    const more = Math.max(0, beat.total - shown.length);
    if (shown.length === 0 && more === 0) return [];
    const y = box.y + box.h - SCENE_CARD_H / 2;
    const room = box.w - 2 * INSET - (more > 0 ? MORE_W + (shown.length > 0 ? GAP : 0) : 0);
    const w = shown.length > 0 ? Math.max(0, (room - GAP * (shown.length - 1)) / shown.length) : 0;
    const out: SceneCardBox[] = shown.map((s, i) => ({ key: `${beat.beatElementId}:${s.sceneId}`, kind: 'scene', beatElementId: beat.beatElementId, sceneId: s.sceneId, x: box.x + INSET + i * (w + GAP), y, w }));
    if (more > 0) out.push({ key: `${beat.beatElementId}:more`, kind: 'more', beatElementId: beat.beatElementId, sceneId: null, x: box.x + box.w - INSET - MORE_W, y, w: MORE_W });
    return out;
}

const CARD = 'pointer-events-auto absolute flex items-center overflow-hidden rounded border border-border-default bg-bg-default px-1 text-[11px] leading-none text-content-default shadow-sm hover:border-border-emphasis focus-visible:outline focus-visible:outline-2';

function Cards({ value }: { value: SceneCardsValue }) {
    const boxes = useNodeBoxes();
    const cards = useMemo(() => {
        const out: Array<SceneCardBox & { title: string; total: number }> = [];
        for (const [beatElementId, beat] of value.beats) {
            const box = boxes.get(beatElementId);
            if (!box) continue;
            const titles = new Map(beat.scenes.map((s) => [s.sceneId, s.title ?? value.words.untitled] as const));
            for (const c of sceneCardBoxes(box, beat)) out.push({ ...c, title: c.sceneId ? (titles.get(c.sceneId) ?? value.words.untitled) : '', total: beat.total - beat.scenes.slice(0, BOARD_SCENES_PER_BEAT).length });
        }
        return out;
    }, [boxes, value]);
    if (cards.length === 0) return null;
    const follow = (e: MouseEvent, open: () => void) => {
        stopEventPropagation(e);
        // A modified click (a new tab, a new window) follows the link as the browser would.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        open();
    };
    return (
        <div className="absolute left-0 top-0" data-scene-cards="true">
            {cards.map((c) =>
                c.kind === 'scene' && c.sceneId ? (
                    <a
                        key={c.key}
                        href={value.href(c.sceneId)}
                        className={CARD}
                        style={{ left: c.x, top: c.y, width: c.w, height: SCENE_CARD_H }}
                        aria-label={value.words.open(c.title)}
                        title={c.title}
                        data-scene-card={c.sceneId}
                        data-scene-card-beat={c.beatElementId}
                        onPointerDown={stopEventPropagation}
                        onPointerUp={stopEventPropagation}
                        onClick={(e) => follow(e, () => value.onOpenScene(c.sceneId!))}
                    >
                        <span className="truncate">{c.title}</span>
                    </a>
                ) : (
                    <button
                        key={c.key}
                        type="button"
                        className={`${CARD} justify-center font-medium text-content-muted`}
                        style={{ left: c.x, top: c.y, width: c.w, height: SCENE_CARD_H }}
                        aria-label={value.words.moreAria(c.total)}
                        data-scene-card-more={c.beatElementId}
                        onPointerDown={stopEventPropagation}
                        onPointerUp={stopEventPropagation}
                        onClick={(e) => {
                            stopEventPropagation(e);
                            value.onOpenBeat(c.beatElementId);
                        }}
                    >
                        {value.words.more(c.total)}
                    </button>
                ),
            )}
        </div>
    );
}

/** The plot board's scene cards, as tldraw's `Overlays` draws them (page space, above the shapes); nothing on the other maps. */
export function SceneCardsLayer() {
    const value = useContext(SceneCardsContext);
    if (!value || value.beats.size === 0) return null;
    return (
        <GhostBoundary>
            <Cards value={value} />
        </GhostBoundary>
    );
}
