'use client';

/**
 * `<RichTextEditor>` — reusable authoring primitive built on Tiptap.
 *
 * Two-mode editor:
 *
 *   - **MARKDOWN** — plain `<textarea>` editing. The current policy
 *     content path stores markdown as literal text (no markdown
 *     parser at render time); we preserve that contract bit-for-bit
 *     so existing rendering keeps working.
 *
 *   - **HTML** (WYSIWYG) — Tiptap `EditorContent` with the
 *     starter-kit extensions, link, placeholder. Output is HTML
 *     and the consumer is expected to run it through
 *     `sanitizePolicyContent('HTML', ...)` (or equivalent
 *     `sanitizeRichTextHtml`) before persistence; the backend
 *     already does this defensively at the policy usecase layer.
 *
 * Mode toggle is internal — the consumer passes a `contentType` and
 * receives `(value, contentType)` updates from `onChange`. Switching
 * modes preserves the underlying text payload (markdown text drops
 * into Tiptap as plain paragraphs; HTML coming back goes into the
 * textarea verbatim — round-trip-safe for the storage layer because
 * the contentType prop changes at the same time).
 *
 * Phase 1.H (#19) hardened the lifted editor:
 *
 *   - `onChange` reports EDITS only. A mode switch is reported through
 *     `onModeChange(mode, value)` with the payload in the new mode, and is
 *     never an edit: the switch to markdown used to emit the plain text
 *     (formatting gone) through `onChange`, so a consumer that saved on
 *     change lost every format on a click.
 *   - `disabled` disables every toolbar button, not only the mode toggle,
 *     and turns editing off in an editor already mounted.
 *   - The mode labels and the markdown textarea's label come from next-intl.
 *   - The content area takes its colours from the tokens, which hold WCAG
 *     AA in both themes; the inverted-prose class it carried named a
 *     typography plugin this product does not ship.
 *   - A new `value` is applied whenever it differs from what the editor last
 *     reported, so a parent may reset the editor in the same tick as an edit
 *     (the old microtask gate dropped such a reset).
 *
 * Bundle posture: callers SHOULD lazy-load this component via
 * `next/dynamic({ ssr: false })` so the Tiptap + ProseMirror chunks
 * (~200KB gzipped) don't land in every policy detail page render —
 * only when the user opens the editor tab.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Card } from '@/components/ui/card';
import {
    Bold,
    Italic,
    Strikethrough,
    Heading1,
    Heading2,
    List,
    ListOrdered,
    Quote,
    Code as CodeIcon,
    Link as LinkIcon,
    SeparatorHorizontal,
    Eye,
    Pencil,
} from 'lucide-react';

export type RichTextContentType = 'MARKDOWN' | 'HTML';

export interface RichTextEditorProps {
    /** Current text payload — interpretation depends on `contentType`. */
    value: string;
    /** Markdown text vs HTML markup. Drives the rendered editor mode. */
    contentType: RichTextContentType;
    /**
     * Called on every EDIT, with the content type the value is in. A mode
     * switch is not an edit and never calls it (`onModeChange`).
     */
    onChange: (value: string, contentType: RichTextContentType) => void;
    /**
     * Called when the author switches mode, with the payload as it reads in
     * the new mode: the plain text on the way to markdown (formatting gone),
     * the text as escaped paragraphs on the way to WYSIWYG. A consumer that
     * keeps `value` in sync should take it; nothing here was typed.
     */
    onModeChange?: (contentType: RichTextContentType, value: string) => void;
    /** Placeholder shown in the empty editor body. */
    placeholder?: string;
    /** Disable editing entirely (still renders the current value). */
    disabled?: boolean;
    /** Min editor height. Default `300px`. */
    minHeightPx?: number;
    /** Optional id to forward (E2E selectors). */
    id?: string;
    /** Test id for the outer wrapper. */
    'data-testid'?: string;
    className?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Tiptap's StarterKit ships with sensible defaults; we tighten the
 * Link extension so it cannot mint un-prefixed JS / data: URLs (the
 * server-side sanitiser would scrub these anyway, this keeps the
 * editor honest at edit-time).
 */
function buildExtensions(placeholder: string) {
    return [
        StarterKit.configure({
            heading: { levels: [1, 2, 3] },
            // CodeBlock is overkill for policy authoring; use inline
            // code from StarterKit (Code mark) instead.
            codeBlock: false,
            // Disable the bundled Link mark — we register a tightened
            // standalone `Link.configure(...)` below with stricter
            // protocol validation. Without this, both register under
            // the same name and TipTap warns about duplicate
            // extensions, which can cause non-deterministic behavior
            // for paste handling and link auto-detection.
            link: false,
        }),
        Link.configure({
            openOnClick: false,
            autolink: true,
            HTMLAttributes: {
                rel: 'noopener noreferrer nofollow',
                target: '_blank',
            },
            // Reject dangerous protocols at edit-time.
            validate: (href) => /^(https?:|mailto:|\/)/.test(href),
        }),
        Placeholder.configure({ placeholder }),
    ];
}

// ─── Component ──────────────────────────────────────────────────────

export function RichTextEditor({
    value,
    contentType,
    onChange,
    onModeChange,
    placeholder: placeholderProp,
    disabled = false,
    minHeightPx = 300,
    id,
    'data-testid': dataTestId = 'rich-text-editor',
    className = '',
}: RichTextEditorProps) {
    const t = useTranslations('richtext');
    const placeholder = placeholderProp ?? t('placeholder');
    const [mode, setMode] = useState<RichTextContentType>(contentType);
    // The HTML the editor last reported: a `value` equal to it is the echo of
    // our own edit and is not set back (which would move the caret); any other
    // value — a parent's reset, even in the same tick — is applied.
    const lastEmittedRef = useRef<string | null>(null);

    // ── Tiptap instance ────────────────────────────────────────────
    const editor = useEditor({
        extensions: buildExtensions(placeholder),
        content: contentType === 'HTML' ? value : '',
        editable: !disabled && mode === 'HTML',
        immediatelyRender: false,
        editorProps: {
            attributes: {
                class:
                    'max-w-none p-4 text-sm leading-relaxed text-content-default focus:outline-none [&_a]:text-[var(--brand-default)] [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border-default [&_blockquote]:pl-3 [&_blockquote]:text-content-muted [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-content-emphasis [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-content-emphasis [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_p]:my-1',
                'data-testid': 'rich-text-editor-content',
                role: 'textbox',
                'aria-multiline': 'true',
                'aria-label': t('editorAria'),
            },
        },
        onUpdate: ({ editor: ed }) => {
            const html = ed.getHTML();
            lastEmittedRef.current = html;
            onChange(html, 'HTML');
        },
    });

    // Re-sync an external `value` in HTML mode (a parent's reset). Our own
    // edit's echo is skipped by value, not by a timing gate.
    useEffect(() => {
        if (!editor) return;
        if (mode !== 'HTML') return;
        if (value === lastEmittedRef.current) return;
        if (editor.getHTML() !== value) {
            editor.commands.setContent(value || '', { emitUpdate: false });
        }
    }, [editor, value, mode]);

    // `disabled` reaches an editor already mounted (useEditor reads it once).
    useEffect(() => {
        if (!editor) return;
        editor.setEditable(!disabled && mode === 'HTML', false);
    }, [editor, disabled, mode]);

    // External `contentType` change — drive the mode (rare but
    // supported, e.g. parent flips mode programmatically).
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setMode(contentType);
    }, [contentType]);

    // Toggle between modes. The text payload bridges via:
    //   markdown → HTML: wrap markdown in a single <pre>-ish text
    //     block so newlines preserve. (No markdown parser today —
    //     keeps the bundle lean; user can re-author in WYSIWYG.)
    //   HTML → markdown: extract plain text via editor.getText()
    //     (loses formatting; explicit, expected, and recoverable
    //     because saving doesn't lose the text).
    // A switch is reported through `onModeChange`, never `onChange`, and
    // changes editability without emitting an update.
    const toggleMode = useCallback(() => {
        if (!editor || disabled) return;
        const next: RichTextContentType = mode === 'MARKDOWN' ? 'HTML' : 'MARKDOWN';
        if (next === 'HTML') {
            // Markdown text → set as a single paragraph block so the
            // editor mounts something sensible.
            const seeded = value
                ? value
                      .split(/\n{2,}/)
                      .map((p) => `<p>${escapeHtml(p)}</p>`)
                      .join('')
                : '';
            editor.commands.setContent(seeded, { emitUpdate: false });
            lastEmittedRef.current = editor.getHTML();
            editor.setEditable(true, false);
            setMode('HTML');
            onModeChange?.('HTML', seeded);
        } else {
            const plain = editor.getText();
            editor.setEditable(false, false);
            setMode('MARKDOWN');
            onModeChange?.('MARKDOWN', plain);
        }
    }, [editor, disabled, mode, value, onModeChange]);

    // ── Render ─────────────────────────────────────────────────────
    return (
        <Card
            elevation="inset"
            density="none"
            id={id}
            data-testid={dataTestId}
            data-content-type={mode}
            className={className}
        >
            <Toolbar
                mode={mode}
                editor={editor}
                disabled={disabled}
                onToggleMode={toggleMode}
            />
            {mode === 'MARKDOWN' ? (
                <textarea
                    className="input w-full rounded-none border-0 border-t border-border-default bg-transparent font-mono text-sm focus:ring-0"
                    style={{ minHeight: `${minHeightPx}px` }}
                    value={value}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.value, 'MARKDOWN')}
                    placeholder={placeholder}
                    aria-label={t('markdownAria')}
                    data-testid="rich-text-editor-textarea"
                />
            ) : (
                <div
                    className="border-t border-border-default"
                    style={{ minHeight: `${minHeightPx}px` }}
                >
                    <EditorContent editor={editor} />
                </div>
            )}
        </Card>
    );
}

// ─── Toolbar ────────────────────────────────────────────────────────

function Toolbar({
    mode,
    editor,
    disabled,
    onToggleMode,
}: {
    mode: RichTextContentType;
    editor: Editor | null;
    disabled: boolean;
    onToggleMode: () => void;
}) {
    const t = useTranslations('richtext');
    return (
        <div className="flex flex-wrap items-center gap-1 border-b border-border-default px-2 py-1.5">
            <button
                type="button"
                onClick={onToggleMode}
                disabled={disabled}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-content-muted hover:bg-bg-muted hover:text-content-emphasis disabled:opacity-50"
                aria-label={mode === 'MARKDOWN' ? t('switchToWysiwyg') : t('switchToMarkdown')}
                data-testid="rich-text-editor-toggle"
                data-mode={mode}
            >
                {mode === 'MARKDOWN' ? (
                    <>
                        <Eye size={11} aria-hidden="true" /> {t('modeWysiwyg')}
                    </>
                ) : (
                    <>
                        <Pencil size={11} aria-hidden="true" /> {t('modeMarkdown')}
                    </>
                )}
            </button>
            {mode === 'HTML' && editor && (
                <>
                    <Divider />
                    <FormatButton
                        disabled={disabled}
                        editor={editor}
                        action={() => editor.chain().focus().toggleBold().run()}
                        active={editor.isActive('bold')}
                        icon={<Bold size={12} />}
                        label={t('bold')}
                    />
                    <FormatButton
                        disabled={disabled}
                        editor={editor}
                        action={() => editor.chain().focus().toggleItalic().run()}
                        active={editor.isActive('italic')}
                        icon={<Italic size={12} />}
                        label={t('italic')}
                    />
                    <FormatButton
                        disabled={disabled}
                        editor={editor}
                        action={() => editor.chain().focus().toggleStrike().run()}
                        active={editor.isActive('strike')}
                        icon={<Strikethrough size={12} />}
                        label={t('strikethrough')}
                    />
                    <Divider />
                    <FormatButton
                        disabled={disabled}
                        editor={editor}
                        action={() =>
                            editor.chain().focus().toggleHeading({ level: 1 }).run()
                        }
                        active={editor.isActive('heading', { level: 1 })}
                        icon={<Heading1 size={12} />}
                        label={t('heading1')}
                    />
                    <FormatButton
                        disabled={disabled}
                        editor={editor}
                        action={() =>
                            editor.chain().focus().toggleHeading({ level: 2 }).run()
                        }
                        active={editor.isActive('heading', { level: 2 })}
                        icon={<Heading2 size={12} />}
                        label={t('heading2')}
                    />
                    <Divider />
                    <FormatButton
                        disabled={disabled}
                        editor={editor}
                        action={() =>
                            editor.chain().focus().toggleBulletList().run()
                        }
                        active={editor.isActive('bulletList')}
                        icon={<List size={12} />}
                        label={t('bulletList')}
                    />
                    <FormatButton
                        disabled={disabled}
                        editor={editor}
                        action={() =>
                            editor.chain().focus().toggleOrderedList().run()
                        }
                        active={editor.isActive('orderedList')}
                        icon={<ListOrdered size={12} />}
                        label={t('numberedList')}
                    />
                    <FormatButton
                        disabled={disabled}
                        editor={editor}
                        action={() =>
                            editor.chain().focus().toggleBlockquote().run()
                        }
                        active={editor.isActive('blockquote')}
                        icon={<Quote size={12} />}
                        label={t('quote')}
                    />
                    <FormatButton
                        disabled={disabled}
                        editor={editor}
                        action={() => editor.chain().focus().toggleCode().run()}
                        active={editor.isActive('code')}
                        icon={<CodeIcon size={12} />}
                        label={t('inlineCode')}
                    />
                    <Divider />
                    <FormatButton
                        disabled={disabled}
                        editor={editor}
                        action={() => editor.chain().focus().setHorizontalRule().run()}
                        active={false}
                        icon={<SeparatorHorizontal size={12} />}
                        label={t('pageBreak')}
                    />
                    <Divider />
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                            const url = window.prompt(t('linkUrlPrompt'));
                            if (!url) return;
                            editor
                                .chain()
                                .focus()
                                .extendMarkRange('link')
                                .setLink({ href: url })
                                .run();
                        }}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-content-muted hover:bg-bg-muted hover:text-content-emphasis disabled:pointer-events-none disabled:opacity-50"
                        aria-label={t('insertLink')}
                        data-testid="rich-text-editor-link"
                    >
                        <LinkIcon size={12} />
                    </button>
                </>
            )}
        </div>
    );
}

function Divider() {
    return <span aria-hidden className="mx-0.5 h-3 w-px bg-border-default" />;
}

function FormatButton({
    action,
    active,
    icon,
    label,
    disabled,
}: {
    editor: Editor;
    action: () => void;
    active: boolean;
    icon: React.ReactNode;
    label: string;
    disabled: boolean;
}) {
    return (
        <button
            type="button"
            onClick={action}
            disabled={disabled}
            className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                active
                    ? 'bg-bg-muted text-content-emphasis'
                    : 'text-content-muted hover:bg-bg-muted hover:text-content-emphasis'
            }`}
            aria-label={label}
            aria-pressed={active}
            title={label}
            data-active={active ? 'true' : 'false'}
        >
            {icon}
        </button>
    );
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Cheap HTML-escape used only to seed the editor when migrating
 * markdown text into WYSIWYG mode. The eventual save path runs the
 * full `sanitizeRichTextHtml` allowlist; this is just to avoid
 * mounting raw user text as HTML inside Tiptap.
 */
function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
