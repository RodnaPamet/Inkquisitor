/**
 * The application's page routes, built per workspace: every page lives under
 * `/w/<slug>/` (an author may belong to more than one workspace later, owner
 * decision D4). The sidebar, the command palette and the identity pill all
 * read this one table. Client-safe: no imports.
 */
export const APP_ROUTES = {
    books: (workspaceSlug: string) => `/w/${encodeURIComponent(workspaceSlug)}/books`,
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
