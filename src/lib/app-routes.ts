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
