'use client';

/**
 * The preview of the book's pending structural proposals on a story map
 * (Phase 3.3, D24): a GHOST node for each proposed element this map draws and
 * a GHOST edge for each proposed relation whose ends it shows, plus — on the
 * plot board — a "What happens between these?" control in the gap between two
 * neighbouring beats.
 *
 * Drawn as part of tldraw's `OnTheCanvas` component (beside `LaneBackdrop`),
 * in page space, from React state the host hands down
 * (`StructurePreviewContext`). A ghost is NEVER a record in the store: it is
 * not serialised, not saved, not in a snapshot, cannot be selected or moved
 * and never marks the map dirty (`tests/rendered/canvas-ghost-layer.test.tsx`).
 * It takes no pointer events; the slot controls take theirs and stop their
 * propagation, so a click on one does not start a selection.
 *
 * The ghosts sit inside their own error boundary (`GhostBoundary`): if the
 * preview cannot be drawn it draws nothing and says so through
 * `onPreviewFailed`, and the plain list beside the canvas — the record — goes
 * on working (D24: "the canvas preview may fail without blocking review").
 */
import { Component, createContext, useContext, useMemo, type ReactNode } from 'react';
import { stopEventPropagation, useEditor, useValue } from 'tldraw';

import type { PendingStructureView } from '@/lib/enrichment/api-client';
import { betweenSlots, structurePreview, type BetweenSlot, type PreviewBox } from '@/lib/canvas/structure-preview';
import type { LaneLayout } from '@/lib/canvas/lanes';
import { STORY_NODE_SHAPE_TYPE } from './tldraw/story-node-shape';

export interface StructurePreviewValue {
    pending: readonly PendingStructureView[];
    /** The kinds this map draws: a proposed element of another kind is only listed. */
    drawnKinds: ReadonlySet<string>;
    kindLabels: Readonly<Record<string, string>>;
    /** The words the ghosts carry. */
    words: { proposed: string; between: (a: string, b: string) => string };
    /** The plot board's lanes (the slots), or null. */
    lanes: LaneLayout | null;
    /** Ask "What happens between these?" about a slot; absent for a reader. */
    onSlot?: (slot: BetweenSlot) => void;
    /** The preview threw while drawing: the host says so beside the list. */
    onPreviewFailed?: () => void;
}

export const StructurePreviewContext = createContext<StructurePreviewValue | null>(null);

/** The cards on the canvas now, by element id (page bounds), read reactively from the store (the ghosts and the scene cards share it). */
export function useNodeBoxes(): Map<string, PreviewBox> {
    const editor = useEditor();
    const key = useValue(
        'story-node-boxes',
        () =>
            editor
                .getCurrentPageShapes()
                .filter((s) => s.type === STORY_NODE_SHAPE_TYPE)
                .map((s) => {
                    const b = editor.getShapePageBounds(s.id);
                    const elementId = (s.props as { elementId?: string }).elementId;
                    return b && elementId ? `${elementId}|${Math.round(b.x)}|${Math.round(b.y)}|${Math.round(b.w)}|${Math.round(b.h)}` : '';
                })
                .filter((x) => x !== '')
                .sort()
                .join('\n'),
        [editor],
    );
    return useMemo(() => {
        const out = new Map<string, PreviewBox>();
        for (const line of key.split('\n')) {
            if (!line) continue;
            const [id, x, y, w, h] = line.split('|');
            out.set(id, { x: Number(x), y: Number(y), w: Number(w), h: Number(h) });
        }
        return out;
    }, [key]);
}

function Ghosts({ value }: { value: StructurePreviewValue }) {
    const boxes = useNodeBoxes();
    const preview = useMemo(() => structurePreview(value.pending, boxes, value.drawnKinds), [value.pending, value.drawnKinds, boxes]);
    if (preview.nodes.length === 0 && preview.edges.length === 0) return null;
    const xs = [...preview.nodes.flatMap((n) => [n.x, n.x + n.w]), ...preview.edges.flatMap((e) => [e.from.x, e.to.x])];
    const ys = [...preview.nodes.flatMap((n) => [n.y, n.y + n.h]), ...preview.edges.flatMap((e) => [e.from.y, e.to.y])];
    const minX = Math.min(...xs) - 8;
    const minY = Math.min(...ys) - 8;
    const width = Math.max(...xs) - minX + 8;
    const height = Math.max(...ys) - minY + 8;
    return (
        <div className="pointer-events-none absolute left-0 top-0" data-ghost-layer="true" aria-hidden="true">
            <svg className="absolute overflow-visible" style={{ left: minX, top: minY, width, height }} width={width} height={height}>
                {preview.edges.map((e) => (
                    <g key={e.proposalId} data-ghost-edge={e.proposalId}>
                        <line
                            x1={e.from.x - minX}
                            y1={e.from.y - minY}
                            x2={e.to.x - minX}
                            y2={e.to.y - minY}
                            className="stroke-[var(--brand-default)]"
                            strokeWidth={2}
                            strokeDasharray="6 6"
                            opacity={0.7}
                        />
                        <text x={(e.from.x + e.to.x) / 2 - minX} y={(e.from.y + e.to.y) / 2 - minY - 6} textAnchor="middle" className="fill-[var(--content-muted)] text-xs">
                            {e.label}
                        </text>
                    </g>
                ))}
            </svg>
            {preview.nodes.map((n) => (
                <div
                    key={n.proposalId}
                    className="absolute flex flex-col justify-center gap-1 rounded-md border-2 border-dashed border-[var(--brand-default)] bg-bg-default/80 px-3 py-2 opacity-80"
                    style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
                    data-ghost-node={n.proposalId}
                >
                    <span className="text-xs font-medium uppercase tracking-wide text-content-muted">{value.words.proposed}</span>
                    <span className="truncate text-sm font-semibold text-content-emphasis">{n.name}</span>
                    <span className="truncate text-xs text-content-muted">{value.kindLabels[n.kind] ?? n.kind}</span>
                </div>
            ))}
        </div>
    );
}

/** The plot board's "What happens between these?" controls, one in each gap between neighbouring beats. */
function SlotControls({ value }: { value: StructurePreviewValue }) {
    const slots = useMemo(() => betweenSlots(value.lanes), [value.lanes]);
    const onSlot = value.onSlot;
    if (!onSlot || slots.length === 0) return null;
    return (
        <div className="absolute left-0 top-0" data-slot-controls="true">
            {slots.map((slot) => (
                <button
                    key={`${slot.afterElementId}:${slot.beforeElementId}`}
                    type="button"
                    className="pointer-events-auto absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border-default bg-bg-default text-sm font-semibold text-content-emphasis shadow-sm hover:bg-bg-subtle focus-visible:outline focus-visible:outline-2"
                    style={{ left: slot.point.x, top: slot.point.y }}
                    aria-label={value.words.between(slot.afterName, slot.beforeName)}
                    title={value.words.between(slot.afterName, slot.beforeName)}
                    data-slot-after={slot.afterElementId}
                    data-slot-before={slot.beforeElementId}
                    onPointerDown={stopEventPropagation}
                    onPointerUp={stopEventPropagation}
                    onClick={(e) => {
                        stopEventPropagation(e);
                        onSlot(slot);
                    }}
                >
                    +
                </button>
            ))}
        </div>
    );
}

/** Draws nothing once the preview has thrown, and tells the host once. */
export class GhostBoundary extends Component<{ children: ReactNode; onFailed?: () => void }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    componentDidCatch(): void {
        this.props.onFailed?.();
    }

    render(): ReactNode {
        return this.state.failed ? null : this.props.children;
    }
}

/** The structural preview, as `OnTheCanvas` draws it (above the lanes, under the shapes). */
export function StructurePreviewLayer() {
    const value = useContext(StructurePreviewContext);
    if (!value) return null;
    return (
        <>
            <GhostBoundary onFailed={value.onPreviewFailed}>
                <Ghosts value={value} />
            </GhostBoundary>
            {/* Its own boundary: a failing control must not take the ghosts (or the canvas) with it; the toolbar offers the same slots. */}
            <GhostBoundary>
                <SlotControls value={value} />
            </GhostBoundary>
        </>
    );
}
