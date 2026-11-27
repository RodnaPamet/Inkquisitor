/**
 * The editor's prose-notes hook (Phase 5.2, D34): on open it reads the check
 * and asks for one when the scene was never checked; after a save it waits the
 * debounce and reads again, while the check is behind the text, and hands the
 * editor a new token only for a check of the stored text. The waits are the
 * test's own (fake timers): no verdict rests on a clock.
 */
import { act, renderHook } from '@testing-library/react';
import { useProseNotes } from '@/components/manuscript/use-prose-notes';

type Answer = { status: string; findings: unknown[] };

function respond(answers: Answer[], posts: string[]) {
    const fetchMock = jest.fn(async (url: string, init?: { method?: string }) => {
        if (init?.method === 'POST') {
            posts.push(url);
            return { ok: true, status: 200, json: async () => ({ scheduled: 'SCHEDULED' }) };
        }
        const a = answers.length > 1 ? answers.shift()! : answers[0];
        const body = { sceneId: 's', checkedRevision: 1, textCut: false, findingsCut: false, wordsChecked: 3, readability: null, styleSheetElementId: null, rulesNotRun: [], dismissed: 0, hiddenByRule: 0, ...a };
        return { ok: true, status: 200, json: async () => body };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
}

/** Advance the fake clock and let every promise it released settle. */
async function tick(ms: number) {
    await act(() => jest.advanceTimersByTimeAsync(ms));
}
async function flush() {
    await tick(0);
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('asks for a check of a scene never checked, then reads until it is checked', async () => {
    const posts: string[] = [];
    respond([{ status: 'NOT_CHECKED', findings: [] }, { status: 'PENDING', findings: [] }, { status: 'CHECKED', findings: [] }], posts);
    const { result } = renderHook(() => useProseNotes({ workspaceSlug: 'w', bookId: 'b', sceneId: 's', canEdit: true, revision: 1, firstReadMs: 100, rereadMs: 50 }));
    await tick(1);
    await flush();
    await flush();
    expect(posts).toEqual(['/api/w/w/books/b/manuscript/scenes/s/prose-checks']);
    const tokenBefore = result.current.token;
    for (let i = 0; i < 3; i++) {
        await tick(60);
        await flush();
    }
    expect(result.current.view?.status).toBe('CHECKED');
    expect(result.current.token).toBeGreaterThan(tokenBefore);
});

it('a reader never asks for a check', async () => {
    const posts: string[] = [];
    respond([{ status: 'NOT_CHECKED', findings: [] }], posts);
    renderHook(() => useProseNotes({ workspaceSlug: 'w', bookId: 'b', sceneId: 's', canEdit: false, revision: 1 }));
    await tick(1);
    await flush();
    expect(posts).toEqual([]);
});

it('after a save, waits the debounce before reading; a check still behind the text gives the editor nothing to place', async () => {
    const posts: string[] = [];
    const fetchMock = respond([{ status: 'CHECKED', findings: [] }, { status: 'PENDING', findings: [] }, { status: 'CHECKED', findings: [] }], posts);
    const { result, rerender } = renderHook(({ revision }) => useProseNotes({ workspaceSlug: 'w', bookId: 'b', sceneId: 's', canEdit: true, revision, firstReadMs: 1_000, rereadMs: 200 }), { initialProps: { revision: 1 } });
    await tick(1);
    await flush();
    const reads = fetchMock.mock.calls.length;
    const token = result.current.token;
    rerender({ revision: 2 });
    await tick(999);
    await flush();
    expect(fetchMock.mock.calls.length).toBe(reads);
    await tick(1);
    await flush();
    expect(result.current.view?.status).toBe('PENDING');
    expect(result.current.token).toBe(token);
    await tick(200);
    await flush();
    expect(result.current.view?.status).toBe('CHECKED');
    expect(result.current.token).toBe(token + 1);
});
