/**
 * The dialogue detector and the scene's plain text (Phase 5.2, D34): what is
 * speech under each style sheet setting (and where the detector stops), and
 * the italic runs found beside 3.4's reader without re-deriving its text.
 */
import { RangeSet, speechRanges } from '@/lib/prose-checks/dialogue';
import { boundText, sceneProseText } from '@/lib/prose-checks/scene-text';
import { htmlToPlainText } from '@/lib/search/plain-text';
import { PROSE_TEXT_SAMPLES } from '../../fixtures/prose-checks/text-samples';

const speech = (text: string, style: Parameters<typeof speechRanges>[1]) => speechRanges(text, style).map((r) => text.slice(r.start, r.end));

describe('the dialogue detector', () => {
    it('double marks: curly and straight, and speech left open runs to the paragraph’s end', () => {
        expect(speech('“Come in,” she said. "Now," he said.', 'double')).toEqual(['“Come in,”', '"Now,"']);
        expect(speech('“It went on and on\nShe slept.', 'double')).toEqual(['“It went on and on']);
    });
    it('single marks: an apostrophe inside a word never opens or closes speech', () => {
        expect(speech("‘Don’t go,’ she said. It's the dog's bowl.", 'single')).toEqual(['‘Don’t go,’']);
        expect(speech("'Wait,' he said. Tom's hat.", 'single')).toEqual(["'Wait,'"]);
    });
    it('single marks: a plural possessive inside speech closes it early (a stated limit)', () => {
        expect(speech("'The dogs' bowl is empty,' she said.", 'single')).toEqual(["'The dogs'"]);
    });
    it('guillemets, the dash, and none', () => {
        expect(speech('«Entrez», dit-elle.', 'guillemets')).toEqual(['«Entrez»']);
        expect(speech('— Come in, she said.\nThe door closed.', 'dash')).toEqual(['— Come in, she said.']);
        expect(speech('“Come in,” she said.', 'none')).toEqual([]);
    });
    it('with no sheet: double, single (curly and straight) and guillemets, an apostrophe never opening speech', () => {
        expect(speech('“A,” ‘b,’ «c» \'d,\' she said.', null)).toEqual(['“A,”', '‘b,’', '«c»', "'d,'"]);
        expect(speech("It's the dog's bowl, and they don't know.", null)).toEqual([]);
    });
    it('a range set answers overlaps by binary search', () => {
        const set = new RangeSet([
            { start: 10, end: 20 },
            { start: 0, end: 5 },
        ]);
        expect([set.overlaps(4, 6), set.overlaps(5, 10), set.overlaps(19, 30), set.contains(20), set.contains(0)]).toEqual([true, false, true, false, true]);
    });
});

describe('the scene’s plain text', () => {
    it('is exactly 3.4’s reader over the stored HTML (mentions as @Name, a break between blocks)', () => {
        const html = '<p>She  met <span data-mention="e1">@Gull</span> at <em>dusk</em>.</p><ul><li><p>One</p></li></ul><blockquote><p>Two<br>three</p></blockquote><hr><p>&amp; then</p>';
        expect(sceneProseText(html).text).toBe(htmlToPlainText(html));
        expect(sceneProseText(html).text).toBe('She met @Gull at dusk.\nOne\nTwo\nthree\n& then');
    });
    it.each(PROSE_TEXT_SAMPLES.map((s) => [s.name, s]))('reads the shared sample "%s" as the editor rebuilds it', (_name, sample) => {
        expect(sceneProseText(sample.html).text).toBe(sample.plain);
    });

    it('reads a CRLF inside a paragraph as one line break (one character, as the editor reads it as one space)', () => {
        expect(sceneProseText('<p>The tide turned.\r\nHe was very tired.</p>').text).toBe('The tide turned.\nHe was very tired.');
    });
    it('finds mention runs beside the text', () => {
        const html = '<p>She met <span data-mention="e1">@Gull  Rock</span> and <span>plain</span> <span data-mention="e2">@Wren</span>.</p>';
        const { text, mentions } = sceneProseText(html);
        expect(mentions.map((r) => text.slice(r.start, r.end))).toEqual(['@Gull Rock', '@Wren']);
    });
    it('finds italic runs beside the text, a line break ending a run', () => {
        const html = '<p>He <em>never</em> went, <i>not  once</i>.</p><p><em>Yes</em></p>';
        const { text, italics } = sceneProseText(html);
        expect(italics.map((r) => text.slice(r.start, r.end))).toEqual(['never', 'not once', 'Yes']);
    });
    it('bounds a long text at a line break and says so', () => {
        expect(boundText('aaaa\nbbbb\ncccc', 11)).toEqual({ text: 'aaaa\nbbbb', cut: true });
        expect(boundText('short', 10)).toEqual({ text: 'short', cut: false });
        // Never between the halves of a surrogate pair.
        expect(boundText('ab😀cd', 3).text).toBe('ab');
    });
});
