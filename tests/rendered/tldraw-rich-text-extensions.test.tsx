/**
 * tldraw's rich text under the TipTap override (decision D20): the story
 * canvas hands tldraw the extension set it was built for on TipTap 2, so a
 * note editor carries one link extension (tldraw's, `openOnClick: false`) and
 * none of the four extensions TipTap 3's StarterKit added.
 *
 * The first test states the problem the list exists for: tldraw's own default
 * under TipTap 3 duplicates `link`. When a tldraw or TipTap release changes
 * that, this file fails and the override, this list and the major-version
 * guard are read again together.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import { flattenExtensions, generateHTML, type AnyExtension } from '@tiptap/core';
import { tipTapDefaultExtensions, type Editor } from 'tldraw';

import { StoryMapCanvas } from '@/components/canvas/StoryMapCanvas';
import { STORY_TEXT_OPTIONS, STORY_TIPTAP_EXTENSIONS } from '@/components/canvas/tldraw/rich-text-extensions';

const names = (extensions: AnyExtension[]) => flattenExtensions(extensions).map((e) => e.name);
const duplicates = (list: string[]) => list.filter((n, i) => list.indexOf(n) !== i);

it('tldraw’s default list, under TipTap 3, carries two link extensions (why the list exists)', () => {
    expect(duplicates(names(tipTapDefaultExtensions))).toEqual(['link']);
});

it('the story canvas’s list has no duplicate, one link that does not open on click, and none of TipTap 3’s additions', () => {
    const list = names(STORY_TIPTAP_EXTENSIONS);
    expect(duplicates(list)).toEqual([]);
    expect(list.filter((n) => n === 'link')).toHaveLength(1);
    const link = flattenExtensions(STORY_TIPTAP_EXTENSIONS).find((e) => e.name === 'link')!;
    expect((link.options as { openOnClick: boolean }).openOnClick).toBe(false);
    for (const gone of ['underline', 'listKeymap', 'trailingNode', 'blockquote', 'codeBlock', 'horizontalRule']) expect(list).not.toContain(gone);
    for (const kept of ['bold', 'italic', 'code', 'highlight', 'bulletList', 'orderedList', 'undoRedo', 'paragraph', 'text']) expect(list).toContain(kept);
});

it('renders a note’s rich text, link included, without a duplicate-extension warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        const html = generateHTML(
            { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ferry', marks: [{ type: 'link', attrs: { href: 'https://example.org/' } }] }] }] },
            STORY_TIPTAP_EXTENSIONS,
        );
        expect(html).toContain('href="https://example.org/"');
        expect(warn.mock.calls.flat().join(' ')).not.toMatch(/Duplicate extension/);
    } finally {
        warn.mockRestore();
    }
});

it('the mounted canvas runs tldraw on that list', async () => {
    let editor: Editor | undefined;
    await act(async () => {
        render(
            <div style={{ width: 800, height: 600 }}>
                <StoryMapCanvas rows={{ nodes: [], edges: [] }} display={{ nodes: new Map(), edgeLabels: new Map() }} relations={() => []} onEditorReady={(e) => (editor = e)} />
            </div>,
        );
    });
    await act(async () => {
        for (let i = 0; i < 50 && !editor; i++) await new Promise((r) => setTimeout(r, 20));
    });
    expect(editor).toBeDefined();
    expect(editor!.getTextOptions().tipTapConfig?.extensions).toBe(STORY_TEXT_OPTIONS.tipTapConfig.extensions);
});
