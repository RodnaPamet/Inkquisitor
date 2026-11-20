/**
 * tldraw's store diffs, mapped into the engine-free vocabulary.
 *
 * Carved from inflect-compliance's `src/lib/processes/canvas-changes-tldraw.ts`
 * (docs/carve-manifest.md), on the story canvas's record types.
 *
 * tldraw hands over a `RecordsDiff` (`added`, `updated: [from, to]`,
 * `removed`), so "a node moved" versus "a node's size changed" is a
 * comparison of the two records. The host listens with
 * `{ scope: 'document', source: 'user' }`; this file is still defensive about
 * record types it does not recognise, failing toward "do nothing".
 *
 * ONLY THE PERSISTED PROPS ARE COMPARED. A story node also carries props it
 * SHOWS (the element's name, kind label and badge), re-derived from the bible
 * on every load; a change to one of them reaches no row, so classifying it as
 * an edit would mark the map dirty and autosave for nothing. The persisted
 * sets are imported from the serializer, and a test derives them from what
 * the projection actually reads.
 *
 * DERIVED MAPS (Phase 3.2). On the plot board and the timeline a node's
 * position, size and lane are the bible's (`src/lib/canvas/lanes.ts`): the
 * save stores what the bible gives, whatever the canvas holds. So with
 * `{ derivedPositions: true }` a node that only moved or was resized is NOT
 * an edit — a drag there is an order move, sent to the bible, never a map
 * save — and only a node added, removed or re-pointed at another element is.
 *
 * NOTE ON DRAGS. A drag emits an `updated` diff per frame, each substantive,
 * so the host calls `markDirty()` many times; `use-canvas-autosave` restarts
 * its timer on each, so a drag produces one save, timed from the last frame.
 */
import type { ClassifiedChange } from './canvas-changes';
import { STORY_EDGE_BINDING_TYPE, STORY_EDGE_SHAPE_TYPE, STORY_NODE_SHAPE_TYPE } from './shape-types';
import { PERSISTED_EDGE_PROPS, PERSISTED_NODE_PROPS } from '@/components/canvas/tldraw/serializer';

/**
 * The minimum of a tldraw record this file reads.
 *
 * Deliberately structural rather than importing `TLRecord`: the mapper needs
 * `typeName`, `type`, and — for shapes — geometry and props. Typing it this way
 * keeps the classification testable with plain objects.
 */
export interface TldrawRecordLike {
    typeName: string;
    type?: string;
    /** Shape geometry. The projection reads `s.x` / `s.y` as a node's position. */
    x?: number;
    y?: number;
    /**
     * Binding endpoints. The projection reads `b.fromId` / `b.toId` — NOT
     * `props.sourceKey` / `props.targetKey`, which the serializer calls "a
     * denormalised convenience that goes stale the moment one moves". So
     * re-attaching an edge end changes these RECORD fields and no prop, and a
     * comparison that looked only at props would miss it entirely.
     */
    fromId?: string;
    toId?: string;
    /**
     * Declared `object` rather than `Record<string, unknown>` because that is
     * what `TLUnknownShape` says, and a narrower declaration here would make
     * the real store type unassignable. Reads go through `propsOf`, which is
     * the one place the widening happens and is sound: indexing an object by
     * string yields `unknown`, which is exactly how the comparison treats it.
     */
    props?: object;
}

/** A `RecordsDiff`, narrowed to what this file reads. */
export interface TldrawDiffLike {
    added: Record<string, TldrawRecordLike>;
    updated: Record<string, readonly [TldrawRecordLike, TldrawRecordLike]>;
    removed: Record<string, TldrawRecordLike>;
}

type Subject = 'node' | 'edge' | 'freeform' | 'unknown';

/** What kind of thing this record is, in the product's terms. */
function subjectOf(r: TldrawRecordLike): Subject {
    if (r.typeName === 'shape') {
        if (r.type === STORY_NODE_SHAPE_TYPE) return 'node';
        // The drawn edge line is derived from its binding and never saved:
        // its creation and movement follow an edit already counted.
        if (r.type === STORY_EDGE_SHAPE_TYPE) return 'unknown';
        // Any other shape is the freeform layer — a sticky, an arrow, a
        // drawing. It is persisted to `StoryMap.freeformJson`, so adding one
        // IS an edit worth saving, though it never becomes a row.
        return 'freeform';
    }
    if (r.typeName === 'binding') {
        return r.type === STORY_EDGE_BINDING_TYPE ? 'edge' : 'freeform';
    }
    return 'unknown';
}

const substantive = (kind: string): ClassifiedChange => ({
    significance: 'substantive',
    kind,
});

const transient = (kind: string): ClassifiedChange => ({
    significance: 'transient',
    kind,
});

/**
 * Did anything the product cares about move?
 *
 * Two axes, because the projection reads a different record field per subject:
 * a node's position is `s.x` / `s.y`, and an edge's endpoints are `b.fromId` /
 * `b.toId`. Both are RECORD fields rather than props, so neither is reachable
 * through the prop comparison below.
 *
 * Missing the second was a real bug in the first draft of this file: comparing
 * only props and `x`/`y` meant **re-attaching an edge end read as
 * `edge-untouched`** — a persisted change that would never have been saved.
 * The mirror image of the `w`/`h` case, which is a change that is NOT persisted
 * being treated as an edit.
 */
function movedGeometry(from: TldrawRecordLike, to: TldrawRecordLike): boolean {
    return (
        from.x !== to.x ||
        from.y !== to.y ||
        from.fromId !== to.fromId ||
        from.toId !== to.toId
    );
}

/**
 * Which props are persisted for this subject, or `null` when all of them are
 * (an edge's every prop reaches a row; a freeform record is carried whole).
 */
function persistedPropsFor(subject: Subject): readonly string[] | null {
    switch (subject) {
        case 'node':
            return PERSISTED_NODE_PROPS;
        case 'edge':
            return PERSISTED_EDGE_PROPS;
        case 'freeform':
        case 'unknown':
            return null;
    }
}

/** The one place `object` is read as a string-keyed bag. */
function propsOf(r: TldrawRecordLike): Record<string, unknown> {
    return (r.props ?? {}) as Record<string, unknown>;
}

/** Did a persisted prop change? JSON per key: props are declared JSON-serialisable. */
function changedProps(
    from: TldrawRecordLike,
    to: TldrawRecordLike,
    subject: Subject,
): boolean {
    const a = propsOf(from);
    const b = propsOf(to);
    const keys = persistedPropsFor(subject) ?? [
        ...new Set([...Object.keys(a), ...Object.keys(b)]),
    ];
    return keys.some(
        (k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null),
    );
}

export interface ClassifyOptions {
    /** The map derives node positions from the bible (the plot board, the timeline): a node's geometry is not the map's. */
    derivedPositions?: boolean;
}

function classifyUpdate(
    from: TldrawRecordLike,
    to: TldrawRecordLike,
    options: ClassifyOptions = {},
): ClassifiedChange {
    const subject = subjectOf(to);
    const derivedNode = subject === 'node' && options.derivedPositions === true;
    const moved = derivedNode ? false : movedGeometry(from, to);
    // A freeform record is stored WHOLE, so any field of it is an edit — a
    // note's rotation, its frame, its lock — not only its props.
    const edited =
        subject === 'freeform'
            ? JSON.stringify(from) !== JSON.stringify(to)
            : derivedNode
              ? JSON.stringify(propsOf(from).elementId ?? null) !== JSON.stringify(propsOf(to).elementId ?? null)
              : changedProps(from, to, subject);

    if (!moved && !edited) {
        // A record rewritten with no difference the product can see — a
        // rotation, an index reorder, a selection-driven field. Not an edit.
        return transient(`${subject}-untouched`);
    }
    if (subject === 'unknown') return transient('unknown-updated');

    // Both can be true in one diff (drag a node while its label is being
    // edited). Naming geometry first is arbitrary but stable; the significance
    // is the same either way, which is what the host acts on.
    // An edge does not "move" — its ENDPOINTS change. Same significance, but a
    // reader of an autosave log should not be told a binding was dragged.
    if (moved && !edited) {
        return substantive(subject === 'edge' ? 'edge-reattached' : `${subject}-moved`);
    }
    if (edited && !moved) return substantive(`${subject}-data-replaced`);
    return substantive(
        subject === 'edge'
            ? 'edge-reattached-and-replaced'
            : `${subject}-moved-and-replaced`,
    );
}

/**
 * Classify one tldraw store diff: one entry per changed record, so
 * `batchIsSubstantive` answers the host's question over the whole diff.
 */
export function classifyTldrawDiff(diff: TldrawDiffLike, options: ClassifyOptions = {}): ClassifiedChange[] {
    const out: ClassifiedChange[] = [];

    for (const r of Object.values(diff.added)) {
        const subject = subjectOf(r);
        out.push(
            subject === 'unknown'
                ? transient('unknown-added')
                : substantive(`${subject}-added`),
        );
    }

    for (const r of Object.values(diff.removed)) {
        const subject = subjectOf(r);
        out.push(
            subject === 'unknown'
                ? transient('unknown-removed')
                : substantive(`${subject}-removed`),
        );
    }

    for (const [from, to] of Object.values(diff.updated)) {
        out.push(classifyUpdate(from, to, options));
    }

    return out;
}

/**
 * The entry point the host calls: `RecordsDiff` keys its maps by BRANDED ids,
 * so the maps are rebuilt with plain string keys (no cast).
 */
export function classifyTldrawStoreDiff(
    diff: {
        added: Readonly<Record<string, TldrawRecordLike>>;
        updated: Readonly<Record<string, readonly [TldrawRecordLike, TldrawRecordLike]>>;
        removed: Readonly<Record<string, TldrawRecordLike>>;
    },
    options: ClassifyOptions = {},
): ClassifiedChange[] {
    return classifyTldrawDiff(
        {
            added: Object.fromEntries(Object.entries(diff.added)),
            updated: Object.fromEntries(Object.entries(diff.updated)),
            removed: Object.fromEntries(Object.entries(diff.removed)),
        },
        options,
    );
}
