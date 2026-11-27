/**
 * The prose notes in the scene editor (Phase 5.2, D34), in a real TipTap
 * editor:
 *
 *   - the editor rebuilds the server's plain text from its own document, so a
 *     finding's offsets land on the same words (the shared samples), and a
 *     finding whose text the editor no longer holds is not placed
 *   - notes and the SUGGESTION MARK are decorations: drawn, never part of the
 *     document — the HTML the autosave sends holds none of them
 *   - accepting a suggestion is an ordinary edit, reported through `onChange`
 *     (the autosave's path) like a keystroke; nothing changes until then
 *   - typing inside a note drops it; typing before it moves it
 */
import { act, render, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { SceneMention, SceneTextEditor, type SceneEditorApi } from '@/components/manuscript/SceneTextEditor';
import { currentProseNotes, docTextBetween, ProseNotes, setActiveProseNote, setProseNotes } from '@/components/manuscript/prose-notes-extension';
import { buildEditorTextMap, placeRange, type DocNodeLike } from '@/lib/prose-checks/editor-map';
import type { ProseFindingView } from '@/lib/prose-checks/vocabulary';
import { PROSE_TEXT_SAMPLES } from '../fixtures/prose-checks/text-samples';

/** The text a class covers in a view (a decoration may be split into several spans where others overlap it). */
function covered(root: Element, selector: string): string {
    return [...root.querySelectorAll(selector)].map((el) => el.textContent ?? '').join('');
}

function editorOf(html: string): Editor {
    return new Editor({ extensions: [StarterKit.configure({ heading: false, codeBlock: false, code: false, link: false }), SceneMention, ProseNotes], content: html });
}

const editors: Editor[] = [];
afterEach(() => {
    while (editors.length) editors.pop()!.destroy();
});
function make(html: string): Editor {
    const e = editorOf(html);
    editors.push(e);
    return e;
}

describe('the editor rebuilds the server’s plain text', () => {
    it.each(PROSE_TEXT_SAMPLES.map((s) => [s.name, s]))('"%s"', (_name, sample) => {
        expect(buildEditorTextMap(make(sample.html).state.doc as unknown as DocNodeLike).text).toBe(sample.plain);
    });

    it('maps offsets to the very words, and refuses a range whose text moved', () => {
        const e = make('<p>She met <span data-mention="e1">@Gull</span> at  dusk.</p><p>He was very tired.</p>');
        const map = buildEditorTextMap(e.state.doc as unknown as DocNodeLike);
        const at = map.text.indexOf('very');
        const r = placeRange(map, at, at + 4, 'very')!;
        expect(docTextBetween(e.state.doc, r.from, r.to)).toBe('very');
        const g = map.text.indexOf('@Gull');
        const m = placeRange(map, g, g + 5, '@Gull')!;
        expect(docTextBetween(e.state.doc, m.from, m.to)).toBe('@Gull');
        expect(placeRange(map, at, at + 4, 'vast')).toBeNull();
        expect(placeRange(map, 0, map.text.length + 1)).toBeNull();
    });
});

describe('notes are decorations, and the suggestion mark draws without editing', () => {
    function placeVery(e: Editor) {
        const map = buildEditorTextMap(e.state.doc as unknown as DocNodeLike);
        const at = map.text.indexOf('very');
        const r = placeRange(map, at, at + 4, 'very')!;
        const s = placeRange(map, at, at + 5)!;
        setProseNotes(e, [{ id: 'n1', from: r.from, to: r.to, severity: 'NOTE', text: 'very', suggestion: { from: s.from, to: s.to, replacement: '', text: 'very ' } }], null);
    }

    it('draws a note, and the open note’s suggestion, in the view and never in the document', () => {
        const e = make('<p>He was very tired.</p>');
        placeVery(e);
        expect(e.view.dom.querySelector('[data-note-id="n1"]')?.textContent).toBe('very');
        expect(e.view.dom.querySelector('.prose-suggest-delete')).toBeNull();
        setActiveProseNote(e, 'n1');
        expect(covered(e.view.dom, '.prose-suggest-delete')).toBe('very ');
        expect(e.getHTML()).toBe('<p>He was very tired.</p>');
        expect(e.getText()).toBe('He was very tired.');
    });

    it('a replacement is drawn as an inserted widget until accepted', () => {
        const e = make('<p>The colour faded.</p>');
        const map = buildEditorTextMap(e.state.doc as unknown as DocNodeLike);
        const at = map.text.indexOf('colour');
        const r = placeRange(map, at, at + 6, 'colour')!;
        setProseNotes(e, [{ id: 'n2', from: r.from, to: r.to, severity: 'WARNING', text: 'colour', suggestion: { from: r.from, to: r.to, replacement: 'color', text: 'colour' } }], 'n2');
        expect(e.view.dom.querySelector('.prose-suggest-insert')?.textContent).toBe('color');
        expect(e.getHTML()).toBe('<p>The colour faded.</p>');
    });

    it('typing before a note moves it; typing inside it drops it', () => {
        const e = make('<p>He was very tired.</p>');
        placeVery(e);
        const before = currentProseNotes(e)[0];
        e.commands.insertContentAt(1, 'So ');
        const moved = currentProseNotes(e)[0];
        expect(moved.from).toBe(before.from + 3);
        expect(docTextBetween(e.state.doc, moved.from, moved.to)).toBe('very');
        e.commands.insertContentAt(moved.from + 2, 'e');
        expect(currentProseNotes(e)).toEqual([]);
    });
});

describe('accepting a suggestion is the author’s edit, through the editor’s autosave path', () => {
    const finding: ProseFindingView = { id: 'f1', ruleId: 'intensifiers', severity: 'NOTE', start: 7, end: 11, matched: 'very', params: { word: 'very' }, suggestion: { start: 7, end: 12, replacement: '', matched: 'very ' } };

    it('places the finding, changes nothing until Accept, then reports the edit through onChange', async () => {
        const onChange = jest.fn();
        const placed = jest.fn();
        let api: SceneEditorApi | null = null;
        const view = render(
            <SceneTextEditor
                workspaceSlug="w"
                bookId="b"
                initialHtml="<p>He was very tired.</p>"
                editable
                onChange={onChange}
                label="Scene text"
                kindLabel={(k) => k}
                proseNotes={{ token: 1, findings: [finding] }}
                activeNoteId="f1"
                onNotesPlaced={placed}
                onApi={(a) => (api = a)}
            />,
        );
        await waitFor(() => expect(placed).toHaveBeenCalledWith(['f1'], 0));
        await waitFor(() => expect(covered(view.container, '.prose-suggest-delete')).toBe('very '));
        // Drawing the note and its suggestion changed no text (the editor may report its unchanged text on mount).
        expect(onChange.mock.calls.every(([html]) => html === '<p>He was very tired.</p>')).toBe(true);
        const before = onChange.mock.calls.length;
        await act(async () => {
            expect(api!.acceptSuggestion('f1')).toBe(true);
        });
        expect(onChange).toHaveBeenCalledTimes(before + 1);
        expect(onChange.mock.calls[before][0]).toBe('<p>He was tired.</p>');
        // The note's text is gone: it cannot be accepted twice.
        await act(async () => {
            expect(api!.acceptSuggestion('f1')).toBe(false);
        });
    });

    it('does not place a finding the editor’s text no longer reads', async () => {
        const placed = jest.fn();
        render(
            <SceneTextEditor
                workspaceSlug="w"
                bookId="b"
                initialHtml="<p>He was vast tired.</p>"
                editable
                onChange={() => undefined}
                label="Scene text"
                kindLabel={(k) => k}
                proseNotes={{ token: 1, findings: [finding] }}
                onNotesPlaced={placed}
            />,
        );
        await waitFor(() => expect(placed).toHaveBeenCalledWith([], 1));
    });
});

describe('a finding at the server’s offsets lands on the very words in the editor', () => {
    function mount(html: string, findings: ProseFindingView[]) {
        const placed = jest.fn();
        const onChange = jest.fn();
        let api: SceneEditorApi | null = null;
        const view = render(
            <SceneTextEditor
                workspaceSlug="w"
                bookId="b"
                initialHtml={html}
                editable
                onChange={onChange}
                label="Scene text"
                kindLabel={(k) => k}
                proseNotes={{ token: 1, findings }}
                activeNoteId={findings[0]?.id ?? null}
                onNotesPlaced={placed}
                onApi={(a) => (api = a)}
            />,
        );
        return { view, placed, onChange, api: () => api! };
    }

    /**
     * An intensifier note as the worker would store it: offsets into the SERVER's plain text of the HTML (`plain`:
     * the unit suite holds `sceneProseText` of each shared sample to it), its deletion taking the space after it.
     */
    function serverFindings(text: string): ProseFindingView[] {
        const at = text.indexOf('very');
        return [{ id: 'f0', ruleId: 'intensifiers', severity: 'NOTE', start: at, end: at + 4, matched: text.slice(at, at + 4), params: { word: 'very' }, suggestion: { start: at, end: at + 5, replacement: '', matched: text.slice(at, at + 5) } }];
    }

    it('after an emoji, a mention and marks: the note covers the word and Accept deletes exactly it', async () => {
        const sample = PROSE_TEXT_SAMPLES.find((x) => x.name.startsWith('an emoji'))!;
        const findings = serverFindings(sample.plain);
        const { view, placed, onChange, api } = mount(sample.html, findings);
        await waitFor(() => expect(placed).toHaveBeenCalledWith(['f0'], 0));
        expect(view.container.querySelector('[data-note-id="f0"]')?.textContent).toBe('very');
        await act(async () => {
            expect(api().acceptSuggestion('f0')).toBe(true);
        });
        expect(onChange.mock.calls.at(-1)?.[0]).toBe('<p>She waved 👋🏽 at <span data-mention="e1" class="scene-mention">@Gull Rock</span> and <strong>was </strong>tired.</p>');
    });

    it('a line break inside a stored paragraph (CRLF) moves nothing after it', async () => {
        // The server's reader reads the CRLF as a line break, the editor as a space: one character either way.
        const findings = serverFindings('The tide turned.\nHe was very tired.');
        const { view, placed } = mount('<p>The tide turned.\r\nHe was very tired.</p>', findings);
        await waitFor(() => expect(placed).toHaveBeenCalledWith(['f0'], 0));
        expect(view.container.querySelector('[data-note-id="f0"]')?.textContent).toBe('very');
    });

    it('places a note but not its suggestion when the text the suggestion covers changed (never a stale edit)', async () => {
        // Checked as "Very sad news.": the deletion re-capitalises the next word ("Very s" → "S"). The editor now reads "Very bad".
        const stale: ProseFindingView = { id: 'f1', ruleId: 'intensifiers', severity: 'NOTE', start: 0, end: 4, matched: 'Very', params: { word: 'Very' }, suggestion: { start: 0, end: 6, replacement: 'S', matched: 'Very s' } };
        const { view, placed, onChange, api } = mount('<p>Very bad news.</p>', [stale]);
        await waitFor(() => expect(placed).toHaveBeenCalledWith(['f1'], 0));
        expect(view.container.querySelector('.prose-suggest-insert')).toBeNull();
        const before = onChange.mock.calls.length;
        await act(async () => {
            expect(api().acceptSuggestion('f1')).toBe(false);
        });
        expect(onChange).toHaveBeenCalledTimes(before);
    });

    it('never places a suggestion over a mention (accepting would replace the whole atom)', async () => {
        const html = '<p>The <span data-mention="e1">@Colour Guard</span> marched.</p>';
        const f: ProseFindingView = { id: 'f1', ruleId: 'spelling-variant', severity: 'WARNING', start: 5, end: 11, matched: 'Colour', params: { word: 'Colour' }, suggestion: { start: 5, end: 11, replacement: 'Color', matched: 'Colour' } };
        const { view, placed, onChange, api } = mount(html, [f]);
        await waitFor(() => expect(placed).toHaveBeenCalledWith(['f1'], 0));
        expect(view.container.querySelector('.prose-suggest-insert')).toBeNull();
        const before = onChange.mock.calls.length;
        await act(async () => {
            expect(api().acceptSuggestion('f1')).toBe(false);
        });
        expect(onChange).toHaveBeenCalledTimes(before);
    });
});
