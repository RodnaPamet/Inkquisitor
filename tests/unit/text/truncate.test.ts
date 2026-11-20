/**
 * Shortening a name for display (Phase 3.H, issue #50 item 5): never at a
 * UTF-16 index, which splits an emoji's surrogate pair into a `�`.
 */
import { truncateGraphemes } from '@/lib/text/truncate';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

it('leaves a text within the bound as it is', () => {
    expect(truncateGraphemes('Wren', 26)).toBe('Wren');
    expect(truncateGraphemes('x'.repeat(26), 26)).toBe('x'.repeat(26));
});

it('cuts a long text to the bound, the ellipsis included', () => {
    const out = truncateGraphemes('x'.repeat(40), 26);
    expect(out).toBe(`${'x'.repeat(25)}…`);
    expect([...out]).toHaveLength(26);
});

it('never splits an emoji, a flag or a letter from its accent where a UTF-16 cut would', () => {
    // 24 letters, then emoji whose surrogate pairs straddle the old cut at code unit 25.
    const name = `${'a'.repeat(24)}🌊🌊🌊🌊`;
    expect(name.slice(0, 25)).toMatch(LONE_SURROGATE); // the defect the old `slice` had
    const out = truncateGraphemes(name, 26);
    expect(out).not.toMatch(LONE_SURROGATE);
    expect(out).toBe(`${'a'.repeat(24)}🌊…`);
    const flags = truncateGraphemes(`${'b'.repeat(24)}🇮🇸🇳🇴🇸🇪`, 26);
    expect(flags).toBe(`${'b'.repeat(24)}🇮🇸…`);
    const accents = truncateGraphemes(`${'c'.repeat(24)}ééé`, 26);
    expect(accents).toBe(`${'c'.repeat(24)}é…`);
});
