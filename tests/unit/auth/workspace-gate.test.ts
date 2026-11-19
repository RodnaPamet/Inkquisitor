/**
 * The edge workspace gate's pure half: which slugs a path names (in every
 * spelling a route could read) and whether the claims admit them.
 */
import { MAX_JWT_MEMBERSHIPS, checkWorkspaceAccess, workspaceGateTarget } from '@/lib/auth/workspace-gate';

describe('workspaceGateTarget', () => {
    it.each([
        ['/w/ada/books', 'page', ['ada']],
        ['/w/ada', 'page', ['ada']],
        ['/api/w/ada/members', 'api', ['ada']],
        ['/W/ada/books', 'page', ['ada']],
        ['/%77/ada/books', 'page', ['ada']],
        ['/api/%77/ada/members', 'api', ['ada']],
        ['//w//ada/books', 'page', ['ada']],
        ['/w/%61da/books', 'page', ['ada']],
    ] as const)('%s → %s %j', (path, kind, slugs) => {
        expect(workspaceGateTarget(path)).toEqual({ kind, slugs });
    });

    it('collects EVERY slug a spelling names, so a traversal cannot smuggle a second workspace past', () => {
        expect(workspaceGateTarget('/w/ada/x%2F..%2F..%2F..%2Fw%2Fother%2Fbooks')?.slugs.sort()).toEqual(['ada', 'other']);
        // One `..` short resolves to /w/w/other: the candidate `w` is foreign too.
        expect(workspaceGateTarget('/w/ada/x%2F..%2F..%2Fw%2Fother%2Fbooks')?.slugs.sort()).toEqual(['ada', 'w']);
        expect(workspaceGateTarget('/w/ada/..%2F..%2Fapi%2Fw%2Fother%2Fmembers')).toMatchObject({ kind: 'api' });
        expect(workspaceGateTarget('/w/ada/..%2F..%2Fapi%2Fw%2Fother%2Fmembers')?.slugs.sort()).toEqual(['ada', 'other']);
    });

    it('a path that only resolves INTO a workspace is still gated', () => {
        expect(workspaceGateTarget('/books/..%2Fw%2Fother')).toEqual({ kind: 'page', slugs: ['other'] });
        expect(workspaceGateTarget('/w\\other/books')?.slugs).toContain('other');
    });

    it('a /w/ with no slug is gated with the empty slug', () => {
        expect(workspaceGateTarget('/w/')).toEqual({ kind: 'page', slugs: [''] });
    });

    it.each(['/', '/login', '/api/health', '/api/auth/session', '/books', '/window/ada', '/api/workspaces'])('%s is not a workspace path', (path) => {
        expect(workspaceGateTarget(path)).toBeNull();
    });
});

describe('checkWorkspaceAccess', () => {
    const mine = [{ slug: 'ada' }, { slug: 'shared' }];

    it('allows a slug the claims hold', () => {
        expect(checkWorkspaceAccess(['ada'], mine)).toBe('allow');
    });

    it('refuses a slug they do not, and refuses if ANY candidate is foreign', () => {
        expect(checkWorkspaceAccess(['other'], mine)).toBe('cross_workspace');
        expect(checkWorkspaceAccess(['ada', 'other'], mine)).toBe('cross_workspace');
    });

    it('is exact: slugs are stored lower-case and a different case names no workspace', () => {
        expect(checkWorkspaceAccess(['Ada'], mine)).toBe('cross_workspace');
    });

    it('no memberships at all is its own answer', () => {
        expect(checkWorkspaceAccess(['ada'], [])).toBe('no_workspace_access');
        expect(checkWorkspaceAccess(['ada'], undefined)).toBe('no_workspace_access');
    });

    it('a capped claim list defers a miss to the server gate, but never the empty slug', () => {
        const capped = Array.from({ length: MAX_JWT_MEMBERSHIPS }, (_, i) => ({ slug: `ws-${i}` }));
        expect(checkWorkspaceAccess(['ws-999'], capped, true)).toBe('allow');
        expect(checkWorkspaceAccess(['ws-999'], capped, false)).toBe('cross_workspace');
        expect(checkWorkspaceAccess([''], capped, true)).toBe('cross_workspace');
    });
});
