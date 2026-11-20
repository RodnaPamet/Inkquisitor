/**
 * The relation picker clamps its search text to what the element list takes
 * (issue #29 item 6): a longer `q` was a 400 the picker showed as a failed
 * search. The server's bound is checked here too, so the two cannot drift.
 */
import { ElementListQuery } from '@/app-layer/schemas/bible';
import { ELEMENT_NAME_MAX } from '@/lib/bible/kinds';
import { pickerQuery } from '@/lib/bible/picker-query';

it('passes a short query trimmed, and no query for blank text', () => {
    expect(pickerQuery('  Mara ')).toBe('Mara');
    expect(pickerQuery('   ')).toBeUndefined();
});

it('clamps a long query to the name bound, which the server accepts', () => {
    const long = 'a'.repeat(ELEMENT_NAME_MAX + 80);
    const q = pickerQuery(long)!;
    expect(q).toHaveLength(ELEMENT_NAME_MAX);
    expect(ElementListQuery.safeParse({ q }).success).toBe(true);
    expect(ElementListQuery.safeParse({ q: long }).success).toBe(false);
});

it('never splits a surrogate pair at the cut (a lone surrogate cannot go into a URL)', () => {
    const text = 'b'.repeat(ELEMENT_NAME_MAX - 1) + '𝔐ara';
    const q = pickerQuery(text)!;
    expect(q).toBe('b'.repeat(ELEMENT_NAME_MAX - 1));
    expect(() => encodeURIComponent(q)).not.toThrow();
});
