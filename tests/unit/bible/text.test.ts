/** Plain author text for storage (src/lib/bible/text.ts). */
import { plainBlock, plainLine } from '@/lib/bible/text';

it('plainLine strips markup and collapses every run of whitespace to one space', () => {
    expect(plainLine('  The <b>tide</b>\n\tturns  ')).toBe('The tide turns');
});

it('plainBlock keeps paragraphs, drops trailing spaces and cuts blank-line runs to one', () => {
    expect(plainBlock('First  \r\n\r\n\r\n\r\nSecond <i>line</i>\t\nThird\n\n')).toBe('First\n\nSecond line\nThird');
});

it('both drop control characters, raw or entity-encoded, keeping tabs and line breaks as whitespace', () => {
    expect(plainLine('A\u0000B&#0;C&#x1;D\u001fE\u007fF')).toBe('ABCDEF');
    expect(plainLine('A\tB')).toBe('A B');
    expect(plainBlock('One\u0000\nTwo&#0;\tthree\r\nFour\u0008')).toBe('One\nTwo\tthree\nFour');
});
