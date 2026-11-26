/**
 * WHAT "CITED" MEANS for propagation debt (Phase 4.2, D28: direct citations
 * only). Pure. An entry D CITES an element U when one of D's accepted versions
 * names, in `sourceAnswerIds`, an ANSWERED answer to a question ABOUT U:
 *
 *   • a question filed under U that is not about an element not yet created
 *     (`aboutPending`: a BETWEEN slot's beat, which is no element), or
 *   • a question about a RELATION with U at one end.
 *
 * Nothing else is a citation: not a mention of U's name, not a relation
 * between D and U on its own, not a session whose context showed U, and
 * nothing transitive (D citing U citing W does not make D cite W). The same
 * definition is the trigger `bible_entry_version_stale_flags` in SQL (migration
 * 20261127110000_continuity), which raises the flags; this function is what a
 * grill session reads back to find which of D's fields the change may touch.
 */

export interface CitedAnswer {
    readonly answerId: string;
    readonly questionElementId: string;
    readonly questionRelationId: string | null;
    readonly aboutPending: boolean;
}

/** The answers among `cited` that are about `upstreamId` (the header). `relationEnds` holds each cited relation's two ends. */
export function answersAbout(upstreamId: string, cited: readonly CitedAnswer[], relationEnds: ReadonlyMap<string, { fromElementId: string; toElementId: string }>): string[] {
    const out: string[] = [];
    for (const a of cited) {
        if (a.aboutPending) continue;
        const ends = a.questionRelationId ? relationEnds.get(a.questionRelationId) : undefined;
        const aboutIt = a.questionRelationId ? !!ends && (ends.fromElementId === upstreamId || ends.toElementId === upstreamId) : a.questionElementId === upstreamId;
        if (aboutIt) out.push(a.answerId);
    }
    return [...new Set(out)];
}
