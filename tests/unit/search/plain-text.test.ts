/**
 * Every source as plain text before a word is cut from it (Phase 3.4): a
 * real HTML parser for rich text, nothing parsed twice, no words fused.
 */
import { fieldValuePlainText, htmlToPlainText, HtmlTextReader, tidyPlainText } from '@/lib/search/plain-text';

describe('htmlToPlainText', () => {
    it('breaks between block elements, so words in neighbouring blocks never fuse', () => {
        expect(htmlToPlainText('<p>The end</p><p>Start again</p>')).toBe('The end\nStart again');
        expect(htmlToPlainText('<ul><li>one</li><li>two</li></ul><h2>Three</h2>four<br>five')).toBe('one\ntwo\nThree\nfour\nfive');
        expect(htmlToPlainText('<table><tr><td>a</td><td>b</td></tr></table>')).toBe('a\nb');
    });

    it('keeps inline elements inside the word they mark', () => {
        expect(htmlToPlainText('<p>light<strong>house</strong> <em>keeper</em></p>')).toBe('lighthouse keeper');
    });

    it('decodes entities once', () => {
        expect(htmlToPlainText('<p>Fish &amp; chips &lt;b&gt; caf&eacute; &#8217;tis &amp;lt;</p>')).toBe('Fish & chips <b> café ’tis &lt;');
    });

    it('drops the contents of script-like elements and every attribute', () => {
        expect(htmlToPlainText('<p title="secret words">Seen</p><script>unseen()</script><style>.x{}</style>')).toBe('Seen');
    });

    it('tidies whitespace: single spaces, trimmed lines, no empty lines', () => {
        expect(htmlToPlainText('<p>  a \t b  </p>\n\n<p></p><p>c\r\nd</p>')).toBe('a b\nc\nd');
    });

    it('reads plain text with no markup as itself', () => {
        expect(htmlToPlainText('no markup here')).toBe('no markup here');
    });

    it('reuses one parser for many values without carrying anything between them', () => {
        const reader = new HtmlTextReader();
        expect(reader.read('<p>first <script>x')).toBe('first');
        expect(reader.read('<p>second</p>')).toBe('second');
    });
});

describe('fieldValuePlainText', () => {
    it('reads each template type as its text', () => {
        expect(fieldValuePlainText({ type: 'richtext' }, '<p>A</p><p>B</p>')).toBe('A\nB');
        expect(fieldValuePlainText({ type: 'text' }, '  a  line ')).toBe('a line');
        expect(fieldValuePlainText({ type: 'list' }, ['one', ' two ', ''])).toBe('one\ntwo');
        expect(fieldValuePlainText({ type: 'choice', options: [{ value: 'antagonist', label: 'Antagonist' }] }, 'antagonist')).toBe('Antagonist');
        expect(fieldValuePlainText({ type: 'scale' }, 4)).toBe('');
    });

    it('never parses a plain-text value as HTML (a literal "<" stays as written)', () => {
        expect(fieldValuePlainText({ type: 'text' }, 'a < b and c > d')).toBe('a < b and c > d');
        expect(tidyPlainText('x <p> y')).toBe('x <p> y');
    });
});
