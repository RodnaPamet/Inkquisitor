/**
 * The canvas autosave loop (Phase 3.1): an edit made while a save is in
 * flight is saved by a follow-up, however close to the save's start it came;
 * a failure stops the loop; `markClean` forgets what it wiped.
 */
import { act, renderHook } from '@testing-library/react';

import { useCanvasAutosave } from '@/lib/canvas/use-canvas-autosave';

function deferred() {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-20T12:00:00Z'));
});
afterEach(() => jest.useRealTimers());

function setup() {
    const saves: Array<ReturnType<typeof deferred>> = [];
    const save = jest.fn(() => {
        const d = deferred();
        saves.push(d);
        return d.promise;
    });
    const hook = renderHook(() => useCanvasAutosave({ save, enabled: true, delayMs: 1000 }));
    return { hook, save, saves };
}

it('an edit in the same millisecond the save started (after it serialised) is saved by a follow-up', async () => {
    const { hook, save, saves } = setup();
    act(() => hook.result.current.markDirty());
    act(() => {
        jest.advanceTimersByTime(1000);
    });
    expect(save).toHaveBeenCalledTimes(1);
    // The clock has not moved since the save started: the edit lands in its millisecond.
    act(() => hook.result.current.markDirty());
    await act(async () => saves[0].resolve());
    expect(hook.result.current.status).toBe('pending');
    act(() => {
        jest.advanceTimersByTime(1000);
    });
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () => saves[1].resolve());
    expect(hook.result.current.status).toBe('saved');
});

it('with no edit while in flight the loop ends saved, and a failure stops it in error', async () => {
    const { hook, save, saves } = setup();
    act(() => hook.result.current.markDirty());
    act(() => {
        jest.advanceTimersByTime(1000);
    });
    await act(async () => saves[0].resolve());
    expect(hook.result.current.status).toBe('saved');
    act(() => hook.result.current.markDirty());
    act(() => {
        jest.advanceTimersByTime(1000);
    });
    await act(async () => saves[1].reject(new Error('down')));
    expect(hook.result.current.status).toBe('error');
    act(() => {
        jest.advanceTimersByTime(10_000);
    });
    expect(save).toHaveBeenCalledTimes(2);
});

it('markClean during a save forgets the edits it wiped, and keeps one made after it', async () => {
    const { hook, save, saves } = setup();
    act(() => hook.result.current.markDirty());
    act(() => {
        jest.advanceTimersByTime(1000);
    });
    act(() => hook.result.current.markDirty());
    act(() => hook.result.current.markClean());
    await act(async () => saves[0].resolve());
    expect(hook.result.current.status).toBe('saved');
    act(() => {
        jest.advanceTimersByTime(5000);
    });
    expect(save).toHaveBeenCalledTimes(1);

    act(() => hook.result.current.markDirty());
    act(() => {
        jest.advanceTimersByTime(1000);
    });
    act(() => hook.result.current.markClean());
    act(() => hook.result.current.markDirty());
    await act(async () => saves[1].resolve());
    expect(hook.result.current.status).toBe('pending');
});
