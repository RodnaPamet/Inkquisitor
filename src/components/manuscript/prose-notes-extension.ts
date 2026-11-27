/**
 * The prose notes in the scene editor (Phase 5.2, D34): a TipTap extension
 * whose ProseMirror plugin holds the notes the margin shows, as DECORATIONS —
 * never as marks or nodes of the document. A decoration is drawn and never
 * saved: the scene's text, its autosave and its versions never see a note
 * (a mark would be serialised into the stored HTML, which the prose profile
 * refuses anyway, D3).
 *
 *   a note        an inline decoration over its range (`prose-note`, its
 *                 severity, `data-note-id`); a click on it opens it in the margin
 *   THE SUGGESTION-MARK PATTERN (D34 item 4): the ACTIVE note's suggestion is
 *                 drawn as a suggestion — the text it would remove struck
 *                 through (`prose-suggest-delete`) and the text it would insert
 *                 as a widget beside it (`prose-suggest-insert`) — and nothing
 *                 changes until the author accepts. `acceptSuggestion` then
 *                 applies it as an ordinary edit (`tr.insertText` / `tr.delete`,
 *                 the marks at the place kept), so it reaches the server through
 *                 the editor's own autosave like any keystroke; rejecting is the
 *                 page's dismissal. The product never applies an edit unasked.
 *   a draft note  Phase 5.3 (D35): a sentence the nightly reading found at odds with the bible, its own kind
 *                 (`prose-note--draft`, its id `draft:<mismatchId>`), held in the same plugin so it maps through edits
 *                 the same way; it has no suggestion (the author fixes the draft, or decides elsewhere)
 *   typing        every note maps through the edit; a note whose own text the
 *                 edit changed is dropped (its next check re-raises it if it
 *                 still applies), and so is a suggestion whose range changed.
 */
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';
import { leafText } from '@/lib/prose-checks/editor-map';
export { DRAFT_NOTE_PREFIX } from '@/lib/draft-facts/vocabulary';

export interface ProseNoteRange {
    id: string;
    from: number;
    to: number;
    severity: 'NOTE' | 'WARNING';
    /** The document's text over [from, to) when it was placed (a note whose text changes is dropped). */
    text: string;
    suggestion: { from: number; to: number; replacement: string; text: string } | null;
    /** Phase 5.3: a draft-vs-bible note (its id `draft:<mismatchId>`); absent for a prose note. */
    kind?: 'DRAFT';
}


interface NotesState {
    notes: ProseNoteRange[];
    active: string | null;
    decorations: DecorationSet;
}

/**
 * The plugin tells the page through DOM events on the editor's element (no
 * callback is captured at render): `PROSE_NOTES_LAYOUT_EVENT` carries every
 * placed note's top (pixels below the editor's top) after any change, so the
 * margin aligns to it; `PROSE_NOTE_ACTIVATE_EVENT` a click on a note's text.
 */
export const PROSE_NOTES_LAYOUT_EVENT = 'prose-notes-layout';
export const PROSE_NOTE_ACTIVATE_EVENT = 'prose-note-activate';

export const proseNotesKey = new PluginKey<NotesState>('proseNotes');

/** The document's text over a range as the notes compare it (a mention as `@Name`). */
export function docTextBetween(doc: PmNode, from: number, to: number): string {
    return doc.textBetween(from, to, '\n', (leaf) => leafText(leaf));
}

function decorationsFor(doc: PmNode, notes: readonly ProseNoteRange[], active: string | null): DecorationSet {
    const decos: Decoration[] = [];
    for (const n of notes) {
        const isActive = n.id === active;
        decos.push(
            Decoration.inline(n.from, n.to, {
                class: `prose-note prose-note--${n.kind === 'DRAFT' ? 'draft' : n.severity === 'WARNING' ? 'warning' : 'note'}${isActive ? ' prose-note--active' : ''}`,
                'data-note-id': n.id,
            }),
        );
        if (isActive && n.suggestion) {
            const s = n.suggestion;
            if (s.to > s.from) decos.push(Decoration.inline(s.from, s.to, { class: 'prose-suggest-delete', 'data-suggestion-for': n.id }));
            if (s.replacement !== '') {
                decos.push(
                    Decoration.widget(
                        s.to,
                        () => {
                            const span = document.createElement('span');
                            span.className = 'prose-suggest-insert';
                            span.setAttribute('data-suggestion-for', n.id);
                            span.setAttribute('aria-hidden', 'true');
                            span.textContent = s.replacement;
                            return span;
                        },
                        { side: 1, key: `insert-${n.id}-${s.replacement}` },
                    ),
                );
            }
        }
    }
    return DecorationSet.create(doc, decos);
}

/** Map every note through an edit; drop a note (or a suggestion) whose own text the edit changed. */
function mapNotes(tr: Transaction, notes: readonly ProseNoteRange[]): ProseNoteRange[] {
    const out: ProseNoteRange[] = [];
    for (const n of notes) {
        const from = tr.mapping.map(n.from, 1);
        const to = tr.mapping.map(n.to, -1);
        if (to <= from || docTextBetween(tr.doc, from, to) !== n.text) continue;
        let suggestion = n.suggestion;
        if (suggestion) {
            const sf = tr.mapping.map(suggestion.from, 1);
            const st = tr.mapping.map(suggestion.to, -1);
            suggestion = st >= sf && docTextBetween(tr.doc, sf, st) === suggestion.text ? { ...suggestion, from: sf, to: st } : null;
        }
        out.push({ ...n, from, to, suggestion });
    }
    return out;
}

function layoutOf(view: EditorView, notes: readonly ProseNoteRange[]): Array<{ id: string; top: number }> {
    let base = 0;
    try {
        base = view.dom.getBoundingClientRect().top;
    } catch {
        base = 0;
    }
    return notes.map((n, i) => {
        let top = i * 32;
        try {
            top = view.coordsAtPos(n.from).top - base;
        } catch {
            // No layout (a test's DOM): the order stands for the position.
        }
        return { id: n.id, top: Number.isFinite(top) ? top : i * 32 };
    });
}

export const ProseNotes = Extension.create({
    name: 'proseNotes',
    addProseMirrorPlugins() {
        let frame: number | null = null;
        const report = (view: EditorView) => {
            if (typeof window === 'undefined') return;
            if (frame !== null) window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(() => {
                frame = null;
                const st = proseNotesKey.getState(view.state);
                view.dom.dispatchEvent(new CustomEvent(PROSE_NOTES_LAYOUT_EVENT, { detail: st ? layoutOf(view, st.notes) : [] }));
            });
        };
        return [
            new Plugin<NotesState>({
                key: proseNotesKey,
                state: {
                    init: (_config, state: EditorState) => ({ notes: [], active: null, decorations: DecorationSet.create(state.doc, []) }),
                    apply(tr, prev): NotesState {
                        const meta = tr.getMeta(proseNotesKey) as { notes?: ProseNoteRange[]; active?: string | null } | undefined;
                        let notes = prev.notes;
                        let active = prev.active;
                        if (meta?.notes) notes = meta.notes;
                        else if (tr.docChanged) notes = mapNotes(tr, notes);
                        if (meta && 'active' in meta) active = meta.active ?? null;
                        if (active !== null && !notes.some((n) => n.id === active)) active = null;
                        if (notes === prev.notes && active === prev.active && !tr.docChanged) return prev;
                        return { notes, active, decorations: decorationsFor(tr.doc, notes, active) };
                    },
                },
                props: {
                    decorations(state) {
                        return proseNotesKey.getState(state)?.decorations ?? null;
                    },
                    handleClick(view, pos) {
                        const st = proseNotesKey.getState(view.state);
                        const hit = st?.notes.find((n) => pos >= n.from && pos <= n.to);
                        if (hit) view.dom.dispatchEvent(new CustomEvent(PROSE_NOTE_ACTIVATE_EVENT, { detail: hit.id }));
                        return false;
                    },
                },
                view(view) {
                    report(view);
                    const onResize = () => report(view);
                    if (typeof window !== 'undefined') window.addEventListener('resize', onResize);
                    return {
                        update: (v) => report(v),
                        destroy: () => {
                            if (typeof window !== 'undefined') {
                                window.removeEventListener('resize', onResize);
                                if (frame !== null) window.cancelAnimationFrame(frame);
                            }
                        },
                    };
                },
            }),
        ];
    },
});

/** Replace the editor's PROSE notes (a fresh check placed); its draft notes stay as they are. */
export function setProseNotes(editor: Editor, notes: ProseNoteRange[], active: string | null): void {
    const kept = (proseNotesKey.getState(editor.state)?.notes ?? []).filter((n) => n.kind === 'DRAFT');
    editor.view.dispatch(editor.state.tr.setMeta(proseNotesKey, { notes: [...notes, ...kept].sort((a, b) => a.from - b.from), active }).setMeta('addToHistory', false));
}

/** Phase 5.3: replace the editor's DRAFT notes (a fresh read placed); its prose notes stay as they are. */
export function setDraftNotes(editor: Editor, notes: ProseNoteRange[]): void {
    const st = proseNotesKey.getState(editor.state);
    const kept = (st?.notes ?? []).filter((n) => n.kind !== 'DRAFT');
    const all = [...kept, ...notes.map((n) => ({ ...n, kind: 'DRAFT' as const, suggestion: null }))].sort((a, b) => a.from - b.from);
    editor.view.dispatch(editor.state.tr.setMeta(proseNotesKey, { notes: all, active: st?.active ?? null }).setMeta('addToHistory', false));
}

/** Open one note (its suggestion drawn), or none. */
export function setActiveProseNote(editor: Editor, active: string | null): void {
    editor.view.dispatch(editor.state.tr.setMeta(proseNotesKey, { active }).setMeta('addToHistory', false));
}

/** Take one note off the editor (dismissed, or its rule turned off). */
export function removeProseNote(editor: Editor, id: string): void {
    const st = proseNotesKey.getState(editor.state);
    if (!st) return;
    editor.view.dispatch(editor.state.tr.setMeta(proseNotesKey, { notes: st.notes.filter((n) => n.id !== id), active: st.active === id ? null : st.active }).setMeta('addToHistory', false));
}

/** The notes as they stand now (mapped through every edit since). */
export function currentProseNotes(editor: Editor): ProseNoteRange[] {
    return proseNotesKey.getState(editor.state)?.notes ?? [];
}

/**
 * Apply a note's suggestion as the author's own edit (they pressed Accept):
 * the replacement inserted over its range with the marks already there, or the
 * range deleted. False when the note or its suggestion is gone (the text moved
 * under it): nothing is changed.
 */
export function acceptProseSuggestion(editor: Editor, id: string): boolean {
    const note = currentProseNotes(editor).find((n) => n.id === id);
    const s = note?.suggestion;
    if (!s) return false;
    if (docTextBetween(editor.state.doc, s.from, s.to) !== s.text) return false;
    const tr = s.replacement === '' ? editor.state.tr.delete(s.from, s.to) : editor.state.tr.insertText(s.replacement, s.from, s.to);
    editor.view.dispatch(tr);
    return true;
}
