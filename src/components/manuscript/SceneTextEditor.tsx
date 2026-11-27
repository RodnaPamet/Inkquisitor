'use client';

/**
 * The scene's prose editor (Phase 5.1): TipTap 3 (the root's line, D20 — no
 * second editor library), cut to prose — paragraphs, emphasis, block quotes,
 * lists, a scene-break rule; no headings, links or code (the server's prose
 * profile, `sanitizeSceneHtml`, refuses them anyway).
 *
 * MENTIONS. Typing `@` opens a picker of the book's elements (the relation
 * picker's clamped search, `pickerQuery`, over the element list); Enter or a
 * click inserts a mention: an atom holding the element's id, written as
 * `<span data-mention="<id>">@Name</span>`. The scene's links are derived from
 * those ids on every save, on the server, which keeps only ids of the book's
 * own elements.
 *
 * The editor reports every edit (`onChange`, with its words counted by the
 * same function the server counts with); it never takes text back from a save.
 * Loaded with `next/dynamic` (no SSR): ProseMirror needs the browser.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EditorContent, mergeAttributes, Node, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { BIBLE_API, bibleFetch, type ElementPageView } from '@/lib/bible/api-client';
import { pickerQuery } from '@/lib/bible/picker-query';
import { countWords } from '@/lib/manuscript/word-count';
import { buildEditorTextMap, placeRange, type DocNodeLike } from '@/lib/prose-checks/editor-map';
import type { ProseFindingView } from '@/lib/prose-checks/vocabulary';
import {
    acceptProseSuggestion,
    docTextBetween,
    PROSE_NOTE_ACTIVATE_EVENT,
    PROSE_NOTES_LAYOUT_EVENT,
    ProseNotes,
    removeProseNote,
    setActiveProseNote,
    setProseNotes,
    type ProseNoteRange,
} from './prose-notes-extension';

/** The mention atom: an element id and the name it showed when inserted. */
export const SceneMention = Node.create({
    name: 'mention',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    addAttributes() {
        return {
            id: {
                default: null,
                parseHTML: (el: HTMLElement) => el.getAttribute('data-mention'),
                renderHTML: (attrs: { id?: string | null }) => (attrs.id ? { 'data-mention': attrs.id } : {}),
            },
            label: {
                default: '',
                parseHTML: (el: HTMLElement) => (el.textContent ?? '').replace(/^@/, ''),
                renderHTML: () => ({}),
            },
        };
    },
    parseHTML() {
        return [{ tag: 'span[data-mention]' }];
    },
    renderHTML({ node, HTMLAttributes }) {
        return ['span', mergeAttributes(HTMLAttributes, { class: 'scene-mention' }), `@${node.attrs.label as string}`];
    },
    renderText({ node }) {
        return `@${node.attrs.label as string}`;
    },
});

/** Picker rows at most. */
const PICKER_TAKE = 8;
const PICKER_DEBOUNCE_MS = 150;
/** `@` and up to thirty characters that are not a space or another `@`, at the end of the text before the cursor (one quantifier, nothing nested). */
const MENTION_TRIGGER = /(?:^|\s)@([^\s@]{0,30})$/;

interface PickerItem {
    id: string;
    name: string;
    kind: string;
}

interface PickerState {
    query: string;
    from: number;
    to: number;
    top: number;
    left: number;
}

export interface SceneTextEditorProps {
    workspaceSlug: string;
    bookId: string;
    initialHtml: string;
    editable: boolean;
    /** Every edit: the editor's HTML and its words. */
    onChange: (html: string, words: number) => void;
    /** The editor's accessible name. */
    label: string;
    kindLabel: (kind: string) => string;
    /**
     * Prose notes to place (5.2, D34): a new `token` places these findings, each only where the editor's own
     * text still reads what the check read (`matched`); null leaves the notes as they are (mapped through edits).
     */
    proseNotes?: { token: number; findings: readonly ProseFindingView[] } | null;
    /** The open note (its suggestion drawn as a suggestion), or null. */
    activeNoteId?: string | null;
    /** Which findings were placed, and how many could not be (the text moved under them). */
    onNotesPlaced?: (placedIds: string[], unplaced: number) => void;
    /** Every placed note's top, below the editor's top, after any change. */
    onNotesLayout?: (layout: Array<{ id: string; top: number }>) => void;
    /** A click on a note's text. */
    onNoteActivate?: (id: string) => void;
    /** The page's handle on the editor: accept a suggestion (an ordinary edit, autosaved), show a note's text. */
    onApi?: (api: SceneEditorApi | null) => void;
}

export interface SceneEditorApi {
    /** Apply a note's suggestion as the author's edit; false when its text moved (nothing changed). */
    acceptSuggestion: (noteId: string) => boolean;
    /** Scroll a note's text into view. */
    revealNote: (noteId: string) => void;
    /** Take notes off the text (dismissed, or their rule turned off). */
    removeNotes: (noteIds: readonly string[]) => void;
}

function triggerAt(editor: Editor): Omit<PickerState, 'top' | 'left'> | null {
    const { selection } = editor.state;
    if (!selection.empty) return null;
    const { $from } = selection;
    const start = Math.max(0, $from.parentOffset - 40);
    const before = $from.parent.textBetween(start, $from.parentOffset, undefined, '￼');
    const m = MENTION_TRIGGER.exec(before);
    if (!m) return null;
    return { query: m[1], from: $from.pos - m[1].length - 1, to: $from.pos };
}

export function SceneTextEditor({
    workspaceSlug,
    bookId,
    initialHtml,
    editable,
    onChange,
    label,
    kindLabel,
    proseNotes = null,
    activeNoteId = null,
    onNotesPlaced,
    onNotesLayout,
    onNoteActivate,
    onApi,
}: SceneTextEditorProps) {
    const t = useTranslations('manuscript.editor');
    const [picker, setPicker] = useState<PickerState | null>(null);
    const [items, setItems] = useState<PickerItem[]>([]);
    const [active, setActive] = useState(0);
    const pickerRef = useRef<PickerState | null>(null);
    const itemsRef = useRef<PickerItem[]>([]);
    const activeRef = useRef(0);
    const editorRef = useRef<Editor | null>(null);
    const onChangeRef = useRef(onChange);
    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);
    useEffect(() => {
        pickerRef.current = picker;
        itemsRef.current = items;
        activeRef.current = active;
    }, [picker, items, active]);

    const choose = useCallback((item: PickerItem) => {
        const ed = editorRef.current;
        const p = pickerRef.current;
        if (!ed || !p) return;
        ed.chain()
            .focus()
            .deleteRange({ from: p.from, to: p.to })
            .insertContent([
                { type: 'mention', attrs: { id: item.id, label: item.name } },
                { type: 'text', text: ' ' },
            ])
            .run();
        setPicker(null);
    }, []);

    const readTrigger = useCallback((ed: Editor) => {
        const found = editable ? triggerAt(ed) : null;
        if (!found) {
            setPicker(null);
            return;
        }
        const coords = ed.view.coordsAtPos(found.from);
        const box = (ed.view.dom.closest('[data-scene-editor]') as HTMLElement | null)?.getBoundingClientRect();
        setPicker({ ...found, top: coords.bottom - (box?.top ?? 0) + 4, left: coords.left - (box?.left ?? 0) });
    }, [editable]);

    const editor = useEditor({
        immediatelyRender: false,
        editable,
        extensions: [
            StarterKit.configure({ heading: false, codeBlock: false, code: false, link: false }),
            Placeholder.configure({ placeholder: t('placeholder') }),
            SceneMention,
            ProseNotes,
        ],
        content: initialHtml,
        editorProps: {
            attributes: { 'aria-label': label, 'aria-multiline': 'true', role: 'textbox', class: 'scene-prose min-h-[60vh] outline-none' },
            handleKeyDown: (_view, event) => {
                const p = pickerRef.current;
                const list = itemsRef.current;
                if (!p) return false;
                if (event.key === 'Escape') {
                    setPicker(null);
                    return true;
                }
                if (list.length === 0) return false;
                if (event.key === 'ArrowDown') {
                    setActive((activeRef.current + 1) % list.length);
                    return true;
                }
                if (event.key === 'ArrowUp') {
                    setActive((activeRef.current - 1 + list.length) % list.length);
                    return true;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                    choose(list[activeRef.current] ?? list[0]);
                    return true;
                }
                return false;
            },
        },
        onUpdate: ({ editor: ed }) => {
            onChangeRef.current(ed.getHTML(), countWords(ed.getText({ blockSeparator: '\n' })));
            readTrigger(ed);
        },
        onSelectionUpdate: ({ editor: ed }) => readTrigger(ed),
    });

    useEffect(() => {
        editorRef.current = editor;
    }, [editor]);

    useEffect(() => {
        editor?.setEditable(editable);
    }, [editor, editable]);

    // Place a fresh check's notes: each where the editor's own text still reads what the check read.
    const notesToken = proseNotes?.token ?? null;
    const placedToken = useRef<number | null>(null);
    useEffect(() => {
        if (!editor || !proseNotes || placedToken.current === proseNotes.token) return;
        placedToken.current = proseNotes.token;
        const doc = editor.state.doc;
        const map = buildEditorTextMap(doc as unknown as DocNodeLike);
        const placed: ProseNoteRange[] = [];
        let unplaced = 0;
        for (const f of proseNotes.findings) {
            const range = placeRange(map, f.start, f.end, f.matched);
            if (!range) {
                unplaced++;
                continue;
            }
            const sRange = f.suggestion ? placeRange(map, f.suggestion.start, f.suggestion.end) : null;
            placed.push({
                id: f.id,
                from: range.from,
                to: range.to,
                severity: f.severity,
                text: docTextBetween(doc, range.from, range.to),
                suggestion: f.suggestion && sRange ? { from: sRange.from, to: sRange.to, replacement: f.suggestion.replacement, text: docTextBetween(doc, sRange.from, sRange.to) } : null,
            });
        }
        setProseNotes(editor, placed, null);
        onNotesPlaced?.(placed.map((p) => p.id), unplaced);
        // Placed once per token: the notes then move with the text by themselves.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor, notesToken]);

    useEffect(() => {
        if (editor) setActiveProseNote(editor, activeNoteId);
    }, [editor, activeNoteId]);

    // The notes plugin speaks through events on the editor's element.
    useEffect(() => {
        if (!editor) return;
        const dom = editor.view.dom;
        const onLayout = (e: Event) => onNotesLayout?.((e as CustomEvent<Array<{ id: string; top: number }>>).detail);
        const onActivate = (e: Event) => onNoteActivate?.((e as CustomEvent<string>).detail);
        dom.addEventListener(PROSE_NOTES_LAYOUT_EVENT, onLayout);
        dom.addEventListener(PROSE_NOTE_ACTIVATE_EVENT, onActivate);
        return () => {
            dom.removeEventListener(PROSE_NOTES_LAYOUT_EVENT, onLayout);
            dom.removeEventListener(PROSE_NOTE_ACTIVATE_EVENT, onActivate);
        };
    }, [editor, onNotesLayout, onNoteActivate]);

    useEffect(() => {
        if (!editor || !onApi) return;
        onApi({
            acceptSuggestion: (id) => acceptProseSuggestion(editor, id),
            removeNotes: (ids) => {
                for (const id of ids) removeProseNote(editor, id);
            },
            revealNote: (id) => {
                if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
                const el = editor.view.dom.querySelector(`[data-note-id="${id}"]`);
                if (el instanceof HTMLElement && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            },
        });
        return () => onApi(null);
    }, [editor, onApi]);

    // The picker's search, debounced; a stale answer is dropped.
    const query = picker?.query ?? null;
    useEffect(() => {
        if (query === null) return;
        let live = true;
        const timer = setTimeout(() => {
            bibleFetch<ElementPageView>(BIBLE_API.elements(workspaceSlug, bookId, { q: pickerQuery(query), take: PICKER_TAKE }))
                .then((page) => {
                    if (!live) return;
                    setItems(page.elements.map((e) => ({ id: e.id, name: e.name, kind: e.kind })));
                    setActive(0);
                })
                .catch(() => {
                    if (live) setItems([]);
                });
        }, PICKER_DEBOUNCE_MS);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [query, workspaceSlug, bookId]);

    return (
        <div className="relative" data-scene-editor="">
            <EditorContent editor={editor} data-testid="scene-text" />
            {picker ? (
                <div
                    className="absolute z-20 w-72 rounded-md border border-border-default bg-bg-elevated p-1 shadow-lg"
                    style={{ top: picker.top, left: picker.left }}
                    data-testid="mention-picker"
                >
                    {items.length === 0 ? (
                        <p className="px-2 py-1.5 text-sm text-content-muted">{t('mentionNone')}</p>
                    ) : (
                        <ul role="listbox" aria-label={t('mentionPicker')} id="scene-mention-picker">
                            {items.map((item, i) => (
                                <li
                                    key={item.id}
                                    role="option"
                                    aria-selected={i === active}
                                    className={`cursor-pointer rounded px-2 py-1.5 text-sm ${i === active ? 'bg-bg-muted text-content-emphasis' : 'text-content-default'}`}
                                    onMouseDown={(e) => {
                                        e.preventDefault();
                                        choose(item);
                                    }}
                                >
                                    <span className="font-medium">{item.name}</span>
                                    <span className="ml-2 text-xs text-content-muted">{kindLabel(item.kind)}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            ) : null}
        </div>
    );
}

export default SceneTextEditor;
