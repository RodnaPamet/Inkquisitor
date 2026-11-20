'use client';

/**
 * The lanes behind a derived map's cards (Phase 3.2): the plot board's act
 * columns, the timeline's axis row with its "not placed yet" zone, and one row
 * per character with a mark under each event that character takes part in.
 *
 * Drawn as tldraw's `OnTheCanvas` component — in page space, under the shapes
 * — from React state the host hands down (`LaneBackdropContext`), so a lane is
 * never a record in the store: it is not saved, cannot be selected or moved,
 * and never marks the map dirty. It takes no pointer events: a drop lands on
 * the canvas, not on a lane.
 */
import { createContext, useContext } from 'react';

import type { LaneLayout } from '@/lib/canvas/lanes';

export const LaneBackdropContext = createContext<LaneLayout | null>(null);

const ROLE_CLASS: Record<string, string> = {
    act: 'border-border-subtle bg-bg-subtle',
    axis: 'border-border-default bg-bg-subtle',
    unplaced: 'border-dashed border-border-default',
    character: 'border-border-subtle',
};

export function LaneBackdrop() {
    const layout = useContext(LaneBackdropContext);
    if (!layout) return null;
    return (
        <div className="pointer-events-none absolute left-0 top-0" data-lane-backdrop={layout.map} aria-hidden="true">
            {layout.bands.map((band) => (
                <div
                    key={band.key}
                    className={`absolute rounded-md border ${ROLE_CLASS[band.role] ?? ''}`}
                    style={{ left: band.x, top: band.y, width: band.w, height: band.h }}
                    data-lane={band.key}
                    data-lane-role={band.role}
                >
                    <span className={`absolute truncate text-xs font-medium text-content-muted ${band.role === 'character' ? 'left-2 top-1/2 max-w-[160px] -translate-y-1/2' : 'left-3 top-3'}`}>
                        {band.label}
                    </span>
                </div>
            ))}
            {layout.marks.map((mark) => (
                <span
                    key={`${mark.characterId}:${mark.elementId}`}
                    className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--brand-default)]"
                    style={{ left: mark.x, top: mark.y }}
                    data-lane-mark={mark.elementId}
                />
            ))}
        </div>
    );
}
