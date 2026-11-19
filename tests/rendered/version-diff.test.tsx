/**
 * `<VersionDiff>` rendered tests — Epic 45.3
 *
 * Locks the diff's UX contract:
 *   - Picker shows every supplied version; defaults to v(prev) → v(current).
 *   - Body uses jsdiff line-level chunks; added / removed / unchanged
 *     each carry the documented data-testid for E2E hooks.
 *   - HTML versions are tag-stripped via htmlToLines before diffing
 *     so the diff is meaningful (paragraph-level), not literal HTML
 *     noise.
 *   - "No textual changes" message renders when the two selected
 *     versions are byte-identical.
 *   - Same-version selection short-circuits to a "pick two different
 *     versions" hint without crashing.
 *   - <2 versions renders the empty-state.
 */

import { render, screen, within, fireEvent } from '@testing-library/react';
import * as React from 'react';

import {
    VersionDiff,
    htmlToLines,
} from '@/components/ui/VersionDiff';

const v1 = {
    id: 'v_1',
    versionNumber: 1,
    contentType: 'MARKDOWN',
    text: 'Line A\nLine B\nLine C',
};
const v2 = {
    id: 'v_2',
    versionNumber: 2,
    contentType: 'MARKDOWN',
    text: 'Line A\nLine B-edited\nLine C\nLine D',
};
const v3 = {
    id: 'v_3',
    versionNumber: 3,
    contentType: 'MARKDOWN',
    text: 'Line A\nLine B-edited\nLine C\nLine D',
};

describe('<VersionDiff>', () => {
    it('renders the picker with every supplied version', () => {
        render(<VersionDiff versions={[v1, v2]} />);
        const fromSel = screen.getByTestId('version-diff-from') as HTMLSelectElement;
        const toSel = screen.getByTestId('version-diff-to') as HTMLSelectElement;
        expect(fromSel.options.length).toBe(2);
        expect(toSel.options.length).toBe(2);
    });

    it('defaults to comparing v(prev) → v(current)', () => {
        render(<VersionDiff versions={[v1, v2]} />);
        const from = screen.getByTestId('version-diff-from') as HTMLSelectElement;
        const to = screen.getByTestId('version-diff-to') as HTMLSelectElement;
        expect(from.value).toBe('v_1');
        expect(to.value).toBe('v_2');
    });

    it('renders added / removed line markers with their data-testids', () => {
        render(<VersionDiff versions={[v1, v2]} />);
        const body = screen.getByTestId('version-diff-body');
        // Line B → Line B-edited, Line D added.
        expect(within(body).getAllByTestId('version-diff-removed').length).toBeGreaterThan(0);
        expect(within(body).getAllByTestId('version-diff-added').length).toBeGreaterThan(0);
        expect(within(body).getAllByTestId('version-diff-unchanged').length).toBeGreaterThan(0);
        // The added text surfaces somewhere in the body.
        expect(body.textContent).toContain('Line D');
        expect(body.textContent).toContain('Line B-edited');
    });

    it('shows "no textual changes" when the two selected versions are identical', () => {
        render(<VersionDiff versions={[v3, v2]} />);
        // v2 and v3 carry the same text; defaults are v3 → v2.
        expect(
            screen.getByTestId('version-diff').textContent,
        ).toMatch(/No textual changes/i);
    });

    it('renders an empty-state placeholder when fewer than 2 versions are available', () => {
        render(<VersionDiff versions={[v2]} />);
        expect(
            screen.getByTestId('version-diff-empty'),
        ).toBeInTheDocument();
    });

    it('calls onSelectionChange when the picker changes', () => {
        const onSelectionChange = jest.fn();
        render(
            <VersionDiff
                versions={[v1, v2, v3]}
                onSelectionChange={onSelectionChange}
            />,
        );
        const from = screen.getByTestId('version-diff-from') as HTMLSelectElement;
        fireEvent.change(from, { target: { value: 'v_2' } });
        expect(onSelectionChange).toHaveBeenCalledWith(
            expect.objectContaining({ fromId: 'v_2' }),
        );
    });

    it('handles HTML versions by stripping tags before diffing', () => {
        const a = {
            id: 'h_1',
            versionNumber: 1,
            contentType: 'HTML',
            text: '<p>Original paragraph one.</p><p>Original paragraph two.</p>',
        };
        const b = {
            id: 'h_2',
            versionNumber: 2,
            contentType: 'HTML',
            text: '<p>Original paragraph one.</p><p>EDITED paragraph two.</p>',
        };
        render(<VersionDiff versions={[a, b]} />);
        const body = screen.getByTestId('version-diff-body');
        // Tag noise should NOT show in the diff body; only the text
        // content of each paragraph.
        expect(body.textContent).not.toContain('<p>');
        expect(body.textContent).toContain('EDITED paragraph two.');
    });
});

describe('htmlToLines', () => {
    it('converts paragraphs and breaks into newlines', () => {
        const out = htmlToLines('<p>Hello</p><p>World</p>');
        expect(out.split('\n').filter(Boolean)).toEqual(['Hello', 'World']);
    });
    it('decodes common entities', () => {
        expect(htmlToLines('<p>5 &lt; 10 &amp; safe</p>')).toBe('5 < 10 & safe');
    });
    it('strips arbitrary HTML tags', () => {
        expect(htmlToLines('<strong>bold</strong> text')).toBe('bold text');
    });
    it('decodes entities once, so text written as "&lt;" stays "&lt;"', () => {
        // The author typed the literal characters "&lt;b&gt;"; the editor
        // stored them as "&amp;lt;b&amp;gt;". One decode, not two.
        expect(htmlToLines('<p>&amp;lt;b&amp;gt;</p>')).toBe('&lt;b&gt;');
        expect(htmlToLines('&amp;amp;')).toBe('&amp;');
        expect(htmlToLines('a&nbsp;&quot;b&quot;&#39;c&#39;')).toBe('a "b"\'c\'');
    });
    it('leaves an unknown entity as written', () => {
        expect(htmlToLines('&copy; &bogus;')).toBe('&copy; &bogus;');
    });
    it('leaves no tag behind when tags are nested inside tag text', () => {
        const out = htmlToLines('<<b>script>alert(1)<</b>/script>');
        expect(out).not.toMatch(/<script/i);
        expect(out).not.toMatch(/<[A-Za-z/!?]/);
    });
    it('removes an unterminated tag at the end of the input', () => {
        expect(htmlToLines('<p>x</p><script src=y')).toBe('x');
    });
    it('keeps a "<" that does not start a tag as text', () => {
        expect(htmlToLines('<p>a < b</p>')).toBe('a < b');
    });
    it('removes a tag re-formed by a first strip', () => {
        // "<scr<b>ipt>" — stripping "<b>" once leaves "<script>".
        const out = htmlToLines('<scr<i>ipt>x</scr<i>ipt>');
        expect(out).not.toMatch(/<[A-Za-z/!?]/);
        expect(out).toContain('x');
    });
    it('strips 100 KB of crafted nesting in linear time (issue #6)', () => {
        // Each '<' is joined to an 's' only once the tag before it is gone:
        // a strip-until-stable loop needed one pass per level (quadratic;
        // 60 KB took about five seconds).
        const k = 34_000;
        const crafted = '<'.repeat(k) + '<b>' + 's>'.repeat(k);
        expect(crafted.length).toBeGreaterThan(100_000);
        const started = performance.now();
        const out = htmlToLines(crafted);
        expect(performance.now() - started).toBeLessThan(100);
        expect(out).not.toMatch(/<[A-Za-z/!?]/);
        // A 100 KB run of unterminated tags and stray '<' is linear too.
        const ragged = '<a <<b'.repeat(20_000);
        const t2 = performance.now();
        expect(htmlToLines(ragged)).not.toMatch(/<[A-Za-z/!?]/);
        expect(performance.now() - t2).toBeLessThan(100);
    });
    it('never leaves a tag-starting "<" on any input built from tag fragments', () => {
        const pieces = ['<', '>', 'b', 's', '/', '<b>', '</p>', 'x', ' ', '<br>', '!', '?'];
        let seed = 7;
        const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
        for (let n = 0; n < 2_000; n++) {
            let input = '';
            for (let j = 0; j < 12; j++) input += pieces[next() % pieces.length];
            expect([input, /<[A-Za-z/!?]/.test(htmlToLines(input))]).toEqual([input, false]);
        }
    });
    it('ends a line at every block, so a heading never glues to the paragraph after it (#5309)', () => {
        const out = htmlToLines(
            '<h2>Scope</h2><p>Applies to staff.</p><ul><li>One</li><li>Two</li></ul><blockquote>Quoted</blockquote><hr><p>End</p>',
        );
        expect(out.split('\n').filter(Boolean)).toEqual([
            'Scope',
            'Applies to staff.',
            'One',
            'Two',
            'Quoted',
            'End',
        ]);
    });
});
