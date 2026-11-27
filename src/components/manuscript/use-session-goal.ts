'use client';

/**
 * A WRITING SESSION'S WORD GOAL (Phase 5.1, D33 item 4). The author sets a
 * goal when they start writing; the editor shows the words written since. A
 * session is the browser tab's (`sessionStorage`): nothing is stored on the
 * server, and closing the tab ends it. What is kept is numbers only — the goal
 * and, per scene opened in the session, its word count when first opened and
 * now — never a word of text.
 *
 * Progress is the net words added across the session's scenes, never below
 * zero (cutting is not negative writing). No goal set is no bar (rule 6: a
 * figure over nothing is not shown as a measure).
 */
import { useCallback, useEffect, useState } from 'react';
import { sessionProgress } from '@/lib/manuscript/word-count';

interface SessionState {
    goal: number | null;
    scenes: Record<string, { base: number; now: number }>;
}

const KEY = (bookId: string) => `inkquisitor-writing-session:${bookId}`;
/** The largest goal the field takes. */
export const SESSION_GOAL_MAX = 100_000;

function read(bookId: string): SessionState {
    try {
        const raw = window.sessionStorage.getItem(KEY(bookId));
        if (!raw) return { goal: null, scenes: {} };
        const parsed = JSON.parse(raw) as Partial<SessionState>;
        const goal = typeof parsed.goal === 'number' && parsed.goal > 0 ? parsed.goal : null;
        const scenes: SessionState['scenes'] = {};
        for (const [id, v] of Object.entries(parsed.scenes ?? {})) {
            if (v && typeof v.base === 'number' && typeof v.now === 'number') scenes[id] = { base: v.base, now: v.now };
        }
        return { goal, scenes };
    } catch {
        return { goal: null, scenes: {} };
    }
}

function write(bookId: string, s: SessionState): void {
    try {
        window.sessionStorage.setItem(KEY(bookId), JSON.stringify(s));
    } catch {
        // A full or disabled storage: the goal lives as long as the page does.
    }
}

export interface SessionGoal {
    goal: number | null;
    /** Net words written in this session, over every scene opened in it. */
    written: number;
    setGoal: (goal: number | null) => void;
    /** The scene's current word count (its first report in the session is its baseline). */
    report: (words: number) => void;
}

export function useSessionGoal(bookId: string, sceneId: string, initialWords: number): SessionGoal {
    const [state, setState] = useState<SessionState>({ goal: null, scenes: {} });

    // The session's state, read once the page is in the browser; this scene's baseline is its words now, if new.
    useEffect(() => {
        const s = read(bookId);
        if (!s.scenes[sceneId]) s.scenes[sceneId] = { base: initialWords, now: initialWords };
        write(bookId, s);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setState(s);
    }, [bookId, sceneId, initialWords]);

    const update = useCallback(
        (change: (s: SessionState) => SessionState) => {
            setState((prev) => {
                const next = change({ goal: prev.goal, scenes: { ...prev.scenes } });
                write(bookId, next);
                return next;
            });
        },
        [bookId],
    );

    const setGoal = useCallback((goal: number | null) => update((s) => ({ ...s, goal: goal && goal > 0 ? Math.min(goal, SESSION_GOAL_MAX) : null })), [update]);
    const report = useCallback(
        (words: number) =>
            update((s) => {
                const prior = s.scenes[sceneId];
                s.scenes[sceneId] = { base: prior?.base ?? words, now: words };
                return s;
            }),
        [update, sceneId],
    );

    const written = Object.values(state.scenes).reduce((n, v) => n + (v.now - v.base), 0);
    return { goal: state.goal, written: sessionProgress(0, written), setGoal, report };
}
