/**
 * The application's page routes, built per workspace: every page lives under
 * `/w/<slug>/` (an author may belong to more than one workspace later, owner
 * decision D4). The sidebar, the command palette and the identity pill all
 * read this one table. Client-safe: no imports.
 */
const bookPath = (workspaceSlug: string, bookId: string) => `/w/${encodeURIComponent(workspaceSlug)}/books/${encodeURIComponent(bookId)}`;

export const APP_ROUTES = {
    books: (workspaceSlug: string) => `/w/${encodeURIComponent(workspaceSlug)}/books`,
    /** A book's home: the board of element kinds. */
    book: (workspaceSlug: string, bookId: string) => `/w/${encodeURIComponent(workspaceSlug)}/books/${encodeURIComponent(bookId)}`,
    /** One bible element of a book. */
    bibleElement: (workspaceSlug: string, bookId: string, elementId: string) =>
        `/w/${encodeURIComponent(workspaceSlug)}/books/${encodeURIComponent(bookId)}/elements/${encodeURIComponent(elementId)}`,
    /** A book's interviews: resume one, see why each stopped (Phase 2.4). */
    interviews: (workspaceSlug: string, bookId: string) => `${bookPath(workspaceSlug, bookId)}/interviews`,
    /** One interview's focused page (Phase 2.4). */
    interview: (workspaceSlug: string, bookId: string, sessionId: string) => `${bookPath(workspaceSlug, bookId)}/interviews/${encodeURIComponent(sessionId)}`,
    /** One interview's proposed bible changes, reviewed field by field (Phase 2.5). */
    interviewReview: (workspaceSlug: string, bookId: string, sessionId: string) => `${bookPath(workspaceSlug, bookId)}/interviews/${encodeURIComponent(sessionId)}/review`,
    /** A book's research: briefs, runs, cited findings and the proposals they support (Phase 2.6). */
    research: (workspaceSlug: string, bookId: string) => `${bookPath(workspaceSlug, bookId)}/research`,
    /** A book's source library: its drafts, notes and earlier books, and the series sources it draws on (Phase 4.0). */
    bookSources: (workspaceSlug: string, bookId: string) => `${bookPath(workspaceSlug, bookId)}/sources`,
    /** The facts a book's sources state, for the author to confirm (Phase 4.0, D23). */
    bookFacts: (workspaceSlug: string, bookId: string) => `${bookPath(workspaceSlug, bookId)}/facts`,
    /** A book's continuity: contradictions, promises, clues, open questions and entries that may be stale (Phase 4.2, D28). */
    continuity: (workspaceSlug: string, bookId: string) => `${bookPath(workspaceSlug, bookId)}/continuity`,
    /** The workspace's series library (Phase 4.0, D26). */
    series: (workspaceSlug: string) => `/w/${encodeURIComponent(workspaceSlug)}/series`,
    /** The series library's facts (Phase 4.0, D26). */
    seriesFacts: (workspaceSlug: string) => `/w/${encodeURIComponent(workspaceSlug)}/series/facts`,
    /** One of a book's story maps (Phase 3.1): `kind` is its URL segment (`mapKindSlug`: relationship, plot, timeline). */
    storyMap: (workspaceSlug: string, bookId: string, kind: string) => `${bookPath(workspaceSlug, bookId)}/maps/${encodeURIComponent(kind)}`,
    /** A new interview, started with the setup in the query (`interviewSetupQuery`, `src/lib/interview/setup.ts`). */
    newInterview: (workspaceSlug: string, bookId: string, query: string) => `${bookPath(workspaceSlug, bookId)}/interviews/new?${query}`,
    /** The workspace's books deleted in the last 30 days (Phase 1.H; the OWNER's). */
    deletedBooks: (workspaceSlug: string) => `/w/${encodeURIComponent(workspaceSlug)}/deleted-books`,
    settings: (workspaceSlug: string) => `/w/${encodeURIComponent(workspaceSlug)}/settings`,
} as const;

/**
 * The workspace slug a page path is under (`/w/<slug>/…`), or null. For
 * chrome mounted ABOVE the workspace layout's provider — the command palette
 * lives in the root providers — which therefore cannot read the workspace
 * context. Only a page the workspace layout has already admitted renders
 * under such a path, so the slug is one the viewer belongs to.
 */
export function workspaceSlugFromPath(pathname: string | null | undefined): string | null {
    const [first, second] = (pathname ?? '').split('/').filter((s) => s !== '');
    if (first !== 'w' || !second) return null;
    try {
        return decodeURIComponent(second);
    } catch {
        return null;
    }
}
