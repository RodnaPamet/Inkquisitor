/**
 * `<RichTextEditor>` rendered tests — Epic 45.2
 *
 * Locks the editor's UX contract:
 *   - Markdown mode renders a `<textarea>` and round-trips text via
 *     `onChange(value, 'MARKDOWN')`.
 *   - WYSIWYG mode mounts the Tiptap content editor + the format
 *     toolbar.
 *   - Mode toggle flips between the two without dropping the
 *     editor's text payload.
 *   - The toolbar's mode-toggle button carries the canonical
 *     `data-testid` so E2E + structural ratchets can drive it.
 *   - The disabled state turns off the textarea + the toolbar
 *     buttons.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';

import {
    RichTextEditor,
    type RichTextContentType,
} from '@/components/ui/RichTextEditor';

// TipTap 3.24+ (ProseMirror) calls `document.elementFromPoint` while
// mounting the editor view; jsdom has no layout engine and lacks it.
// Stub it for THIS file only — a GLOBAL stub (in setup.ts) trips
// axe-core's obscured-element checks and produces false a11y
// violations in the modal/combobox suites. jsdom environments are
// per-file, so this assignment doesn't leak to other suites.
beforeAll(() => {
    Document.prototype.elementFromPoint = () => null;
});

interface HarnessProps {
    initial?: string;
    initialType?: RichTextContentType;
    onChange?: jest.Mock;
    onModeChange?: jest.Mock;
    disabled?: boolean;
}
function Harness({
    initial = '',
    initialType = 'MARKDOWN',
    onChange,
    onModeChange,
    disabled,
}: HarnessProps) {
    const [value, setValue] = React.useState(initial);
    const [type, setType] = React.useState<RichTextContentType>(initialType);
    return (
        <RichTextEditor
            value={value}
            contentType={type}
            disabled={disabled}
            onChange={(v, t) => {
                setValue(v);
                setType(t);
                onChange?.(v, t);
            }}
            onModeChange={(t, v) => {
                setValue(v);
                setType(t);
                onModeChange?.(t, v);
            }}
        />
    );
}

describe('<RichTextEditor>', () => {
    it('mounts in markdown mode by default and renders a textarea', () => {
        render(<Harness />);
        const wrapper = screen.getByTestId('rich-text-editor');
        expect(wrapper.getAttribute('data-content-type')).toBe('MARKDOWN');
        expect(
            screen.getByTestId('rich-text-editor-textarea'),
        ).toBeInTheDocument();
    });

    it('reports onChange(value, "MARKDOWN") when the operator types in the textarea', () => {
        const onChange = jest.fn();
        render(<Harness onChange={onChange} />);
        const ta = screen.getByTestId(
            'rich-text-editor-textarea',
        ) as HTMLTextAreaElement;
        fireEvent.change(ta, { target: { value: '# Heading\n\nBody.' } });
        expect(onChange).toHaveBeenLastCalledWith('# Heading\n\nBody.', 'MARKDOWN');
    });

    it('toggle flips into HTML mode and mounts the Tiptap content + format toolbar', () => {
        render(<Harness initial="A line of text." />);
        const toggle = screen.getByTestId('rich-text-editor-toggle');
        expect(toggle.getAttribute('data-mode')).toBe('MARKDOWN');
        fireEvent.click(toggle);

        // Editor's wrapper data-content-type flips, textarea is gone,
        // EditorContent mounts with the prose-styled content area.
        expect(
            screen.getByTestId('rich-text-editor').getAttribute('data-content-type'),
        ).toBe('HTML');
        expect(screen.queryByTestId('rich-text-editor-textarea')).toBeNull();
        expect(
            screen.getByTestId('rich-text-editor-content'),
        ).toBeInTheDocument();

        // Format toolbar mounts: bold / italic / heading / list / link
        // are reachable by their aria-labels.
        const wrapper = screen.getByTestId('rich-text-editor');
        expect(within(wrapper).getByLabelText(/^Bold$/i)).toBeInTheDocument();
        expect(within(wrapper).getByLabelText(/^Italic$/i)).toBeInTheDocument();
        expect(within(wrapper).getByLabelText(/^Heading 1$/i)).toBeInTheDocument();
        expect(within(wrapper).getByLabelText(/^Bullet list$/i)).toBeInTheDocument();
        expect(within(wrapper).getByLabelText(/^Insert link$/i)).toBeInTheDocument();
        // Page-break button (inserts an <hr> the policy view renders as a
        // labelled break + a real page break in print/PDF).
        expect(within(wrapper).getByLabelText(/^Page break$/i)).toBeInTheDocument();
    });

    it('the Page break button inserts a horizontal rule into the document', () => {
        render(<Harness initial="Intro paragraph." />);
        fireEvent.click(screen.getByTestId('rich-text-editor-toggle'));
        const wrapper = screen.getByTestId('rich-text-editor');
        fireEvent.click(within(wrapper).getByLabelText(/^Page break$/i));
        expect(
            screen.getByTestId('rich-text-editor-content').querySelector('hr'),
        ).not.toBeNull();
    });

    it('a toggle is not an edit: it reports onModeChange with the converted payload and never onChange (#19)', () => {
        const onChange = jest.fn();
        const onModeChange = jest.fn();
        render(<Harness initial="hello" onChange={onChange} onModeChange={onModeChange} />);
        fireEvent.click(screen.getByTestId('rich-text-editor-toggle'));
        // The seeded HTML wraps the markdown in <p>…</p> blocks.
        expect(onModeChange).toHaveBeenLastCalledWith('HTML', '<p>hello</p>');
        fireEvent.click(screen.getByTestId('rich-text-editor-toggle'));
        expect(onModeChange).toHaveBeenLastCalledWith('MARKDOWN', 'hello');
        expect(onChange).not.toHaveBeenCalled();
    });

    it('toggle back from HTML → MARKDOWN extracts the plain text, and emits no update with it', () => {
        const onChange = jest.fn();
        const onModeChange = jest.fn();
        render(<Harness initialType="HTML" initial="<p><strong>alpha</strong> beta</p>" onChange={onChange} onModeChange={onModeChange} />);
        fireEvent.click(screen.getByTestId('rich-text-editor-toggle'));
        expect(onModeChange).toHaveBeenLastCalledWith('MARKDOWN', 'alpha beta');
        // The formatting-stripped text was never reported as an edit.
        expect(onChange).not.toHaveBeenCalled();
    });

    it('disabled: every toolbar button is disabled and pressing one changes nothing (#19)', () => {
        const onChange = jest.fn();
        render(<Harness initialType="HTML" initial="<p>keep</p>" onChange={onChange} disabled />);
        const wrapper = screen.getByTestId('rich-text-editor');
        const buttons = within(wrapper).getAllByRole('button');
        expect(buttons.length).toBeGreaterThan(5);
        for (const b of buttons) expect(b).toBeDisabled();
        fireEvent.click(within(wrapper).getByLabelText(/^Bold$/i));
        fireEvent.click(within(wrapper).getByLabelText(/^Page break$/i));
        expect(screen.getByTestId('rich-text-editor-content').querySelector('hr, strong')).toBeNull();
        expect(screen.getByTestId('rich-text-editor-content').getAttribute('contenteditable')).toBe('false');
        expect(onChange).not.toHaveBeenCalled();
    });

    it('turns editing off in an editor already mounted when disabled arrives later', () => {
        const { rerender } = render(<RichTextEditor value="<p>x</p>" contentType="HTML" onChange={() => undefined} />);
        expect(screen.getByTestId('rich-text-editor-content').getAttribute('contenteditable')).toBe('true');
        rerender(<RichTextEditor value="<p>x</p>" contentType="HTML" onChange={() => undefined} disabled />);
        expect(screen.getByTestId('rich-text-editor-content').getAttribute('contenteditable')).toBe('false');
    });

    it('labels its mode toggle and its markdown textarea from messages/en.json (#19)', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const messages = require('../../messages/en.json') as { richtext: Record<string, string> };
        render(<Harness initial="x" />);
        expect(screen.getByTestId('rich-text-editor-toggle')).toHaveTextContent(messages.richtext.modeWysiwyg);
        expect(screen.getByRole('textbox', { name: messages.richtext.markdownAria })).toBe(screen.getByTestId('rich-text-editor-textarea'));
        fireEvent.click(screen.getByTestId('rich-text-editor-toggle'));
        expect(screen.getByTestId('rich-text-editor-toggle')).toHaveTextContent(messages.richtext.modeMarkdown);
    });

    it('colours its content from the theme tokens, never an inverted prose class (#19)', () => {
        render(<Harness initialType="HTML" initial="<p>x</p>" />);
        const content = screen.getByTestId('rich-text-editor-content');
        expect(content.className).not.toMatch(/prose-invert|\bprose\b/);
        expect(content.className).toContain('text-content-default');
    });

    it('applies a parent reset that arrives in the same tick as an edit (#19)', async () => {
        function Resetting() {
            const [value, setValue] = React.useState('<p>start</p>');
            return (
                <>
                    <RichTextEditor
                        value={value}
                        contentType="HTML"
                        onChange={(v) => {
                            // The parent takes the edit, then resets in the same tick.
                            setValue(v);
                            setValue('<p>reset</p>');
                        }}
                    />
                    <span data-testid="value">{value}</span>
                </>
            );
        }
        render(<Resetting />);
        const wrapper = screen.getByTestId('rich-text-editor');
        await act(async () => {
            fireEvent.click(within(wrapper).getByLabelText(/^Page break$/i));
        });
        expect(screen.getByTestId('value')).toHaveTextContent('<p>reset</p>');
        expect(screen.getByTestId('rich-text-editor-content').textContent).toBe('reset');
    });

    it.each([
        ["<script>alert('x')</script>", '&lt;script&gt;'],
        ["<SCRIPT >alert('x')</SCRIPT >", '&lt;SCRIPT &gt;'],
        ['<img src=x onerror="alert(1)">', '&lt;img src=x onerror='],
    ])(
        'escapes raw HTML in markdown text when seeding the WYSIWYG editor (%s)',
        (payload, escaped) => {
            // Markdown text containing markup must NOT mount as executable
            // HTML inside Tiptap. The editor's seed step escapes it via its
            // internal escapeHtml helper.
            const onModeChange = jest.fn();
            render(<Harness initial={payload} onModeChange={onModeChange} />);
            fireEvent.click(screen.getByTestId('rich-text-editor-toggle'));
            const seeded = onModeChange.mock.calls.at(-1)?.[1] as string;

            // Judge the output by what a parser makes of it, not by a
            // pattern over the string: a regex for a tag misses case,
            // whitespace and attribute variants. A <template> parses
            // inertly (no script runs, no resource loads).
            const template = document.createElement('template');
            template.innerHTML = seeded;
            const elements = Array.from(template.content.querySelectorAll('*'));
            expect(template.content.querySelector('script')).toBeNull();
            const handlerAttributes = elements.flatMap((el) =>
                el.getAttributeNames().filter((name) => name.toLowerCase().startsWith('on')),
            );
            expect(handlerAttributes).toEqual([]);
            // Every element the seed produced is a paragraph wrapper.
            expect(elements.map((el) => el.tagName)).toEqual(
                elements.map(() => 'P'),
            );

            // And the text was escaped, not dropped: it survives verbatim.
            expect(seeded).toContain(escaped);
            expect(template.content.textContent).toBe(payload);
        },
    );

    it('starts in HTML mode when contentType="HTML" is passed', () => {
        render(<Harness initialType="HTML" initial="<p>seed</p>" />);
        expect(
            screen.getByTestId('rich-text-editor').getAttribute('data-content-type'),
        ).toBe('HTML');
        expect(
            screen.getByTestId('rich-text-editor-content'),
        ).toBeInTheDocument();
    });
});
