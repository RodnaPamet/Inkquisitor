/**
 * The TipTap extensions tldraw's rich text (sticky notes, text shapes) runs
 * on in the story canvas: tldraw's own list, with TipTap 3's StarterKit cut
 * back to what TipTap 2's carried (decision D20).
 *
 * WHY. tldraw 3.15 was written against TipTap 2. `package.json` overrides its
 * TipTap dependencies onto the root's 3.x line (GHSA-cp6q-959q-f8rh has no
 * TipTap 2 fix; the 3.1 note), and TipTap 3's StarterKit gained four
 * extensions TipTap 2's did not have: Link, Underline, ListKeymap and
 * TrailingNode. tldraw adds its own Link beside the StarterKit, so under the
 * override every note editor carried TWO link extensions — a "Duplicate
 * extension names" warning on every editor and every rendered note, and a
 * second link plugin with TipTap 3's `openOnClick: true`, where tldraw's own
 * asks `false`. TrailingNode would also append an empty paragraph to a note
 * that ends in a list, changing stored text on an edit. Switching the four off
 * gives tldraw the extension set it was built for.
 *
 * THE OVERRIDE AND THIS LIST MOVE TOGETHER with the tldraw major-version
 * guard: a tldraw release or a TipTap change re-reads both
 * (`tests/rendered/tldraw-rich-text-extensions.test.tsx`), and the sticky-note
 * E2E (`tests/e2e/story-map.spec.ts`) is the override's proof in a browser.
 */
import type { Extensions } from '@tiptap/core';
import { tipTapDefaultExtensions } from 'tldraw';

/** What TipTap 3's StarterKit carries and TipTap 2's did not, switched off. */
export const TIPTAP_3_STARTER_KIT_ADDITIONS = { link: false, underline: false, listKeymap: false, trailingNode: false } as const;

export const STORY_TIPTAP_EXTENSIONS: Extensions = tipTapDefaultExtensions.map((extension) =>
    extension.name === 'starterKit' ? extension.configure(TIPTAP_3_STARTER_KIT_ADDITIONS) : extension,
);

/** The `textOptions` the story canvas hands `<Tldraw>` (tldraw fills in the rest). */
export const STORY_TEXT_OPTIONS = { tipTapConfig: { extensions: STORY_TIPTAP_EXTENSIONS } } as const;
