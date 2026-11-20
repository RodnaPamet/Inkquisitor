/**
 * What a canvas change MEANS — the vocabulary, with no engine named.
 *
 * Carved from inflect-compliance's `src/lib/processes/canvas-changes.ts`
 * (docs/carve-manifest.md). The vocabulary lives apart from the tldraw
 * mapper (`canvas-changes-tldraw.ts`) so the host never sees an engine's
 * change type, and so the mapper is testable with plain objects.
 *
 * On tldraw the editor keeps its own undo stack, so the host applies only
 * ONE consequence of a substantive change: it marks the map dirty for the
 * autosave. Feeding a second, app-level history from here would put two undo
 * entries behind one edit.
 */

/**
 * What the host should do about a change.
 *
 * Deliberately about CONSEQUENCE, not about the shape of the event.
 *
 * The tldraw editor keeps its own undo stack, so its host marks the map dirty
 * and pushes nothing to an app-level history.
 *
 * So read `substantive` as **"an edit worth keeping"**, and let each host apply
 * the consequences its engine leaves to it. The vocabulary still decides which
 * changes matter; it no longer claims both consequences follow together.
 */
export type ChangeSignificance =
    /** Push an undo entry and mark dirty. An edit the user would expect to keep. */
    | 'substantive'
    /**
     * Ignore. Selection, measurement, and the intermediate ticks of a drag —
     * marking these dirty would autosave on every click and bury a real undo
     * point under twenty drag entries.
     */
    | 'transient'
    /**
     * A real edit whose commit path ALREADY pushed history and marked dirty.
     * Classifying it as substantive double-pushes; classifying it as transient
     * says something false about it. Hence a third value.
     */
    | 'handled-by-caller';

/** A change classified into the vocabulary, with the reason kept for the reader. */
export interface ClassifiedChange {
    significance: ChangeSignificance;
    /** Short, stable label — used in tests and in nothing user-facing. */
    kind: string;
}

/** The host's only question. */
export function isSubstantive(c: ClassifiedChange): boolean {
    return c.significance === 'substantive';
}

/**
 * Did any change in a batch warrant an undo entry?
 *
 * Engines report changes in batches, and one substantive change among twenty
 * transient ones still means the document changed. `.some` rather than a filter
 * length, so a batch of a thousand selection ticks costs one early exit.
 */
export function batchIsSubstantive(changes: readonly ClassifiedChange[]): boolean {
    return changes.some(isSubstantive);
}
