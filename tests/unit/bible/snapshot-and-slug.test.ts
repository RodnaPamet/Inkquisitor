/** The version snapshot format (src/lib/bible/snapshot.ts) and element slugs (src/lib/bible/slug.ts). */
import { buildSnapshot, parseSnapshot, serialiseSnapshot, SnapshotUnreadableError } from '@/lib/bible/snapshot';
import { firstFreeSlug, slugCandidates, SLUG_MAX, SLUG_PATTERN, slugify } from '@/lib/bible/slug';

const element = { kind: 'CHARACTER' as const, name: 'Mara', slug: 'mara', status: 'DRAFT' as const, summary: null, customLabel: null };

describe('snapshot', () => {
    it('orders fields by template order, so the same state serialises the same way', () => {
        const a = buildSnapshot({ element, fields: [{ key: 'want', order: 6, value: 'x' }, { key: 'role', order: 1, value: 'y' }] });
        const b = buildSnapshot({ element, fields: [{ key: 'role', order: 1, value: 'y' }, { key: 'want', order: 6, value: 'x' }] });
        expect(serialiseSnapshot(a)).toBe(serialiseSnapshot(b));
        expect(a.fields.map((f) => f.key)).toEqual(['role', 'want']);
    });

    it('round-trips', () => {
        const s = buildSnapshot({ element: { ...element, summary: 'S' }, fields: [{ key: 'defining_traits', order: 3, value: ['a', 'b'] }, { key: 'agency', order: 8, value: 4 }] });
        expect(parseSnapshot(serialiseSnapshot(s))).toEqual(s);
    });

    it('refuses what it cannot read, rather than returning an empty element', () => {
        expect(() => parseSnapshot('not json')).toThrow(SnapshotUnreadableError);
        expect(() => parseSnapshot(JSON.stringify({ format: 2, element, fields: [] }))).toThrow(SnapshotUnreadableError);
        expect(() => parseSnapshot(JSON.stringify({ format: 1, element: { ...element, kind: 'DRAGON' }, fields: [] }))).toThrow(SnapshotUnreadableError);
    });
});

describe('slug', () => {
    it('derives a URL-safe slug from a name', () => {
        expect(slugify('Mara of the Salt Roads')).toBe('mara-of-the-salt-roads');
        expect(slugify('  Élodie  Ça-va? ')).toBe('elodie-ca-va');
        expect(slugify('!!!')).toBe('');
        expect(slugify('x'.repeat(200))).toHaveLength(SLUG_MAX);
        expect(slugify('Mara of the Salt Roads')).toMatch(SLUG_PATTERN);
    });

    it('picks the first free slug, staying within the bound', () => {
        expect(firstFreeSlug('mara', new Set())).toBe('mara');
        expect(firstFreeSlug('mara', new Set(['mara', 'mara-2']))).toBe('mara-3');
        const long = 'x'.repeat(SLUG_MAX);
        const free = firstFreeSlug(long, new Set([long]));
        expect(free.length).toBeLessThanOrEqual(SLUG_MAX);
        expect(free).toMatch(SLUG_PATTERN);
    });
});

describe('slug candidates (Phase 1.1 review)', () => {
    it('a long base is shortened for its suffix, so a lookup must ask for the candidates themselves', () => {
        const long = 'a'.repeat(SLUG_MAX);
        const [first, second, third] = slugCandidates(long, 1, 3);
        expect(first).toBe(long);
        expect(second).toBe(`${'a'.repeat(SLUG_MAX - 2)}-2`);
        expect(third).toBe(`${'a'.repeat(SLUG_MAX - 2)}-3`);
        // The shortened candidates do not start with `<base>-`: a prefix lookup on the base misses them.
        expect(second.startsWith(`${long}-`)).toBe(false);
        expect(firstFreeSlug(long, new Set([first, second]))).toBe(third);
        for (const c of slugCandidates(long, 1, 200)) expect(c).toMatch(SLUG_PATTERN);
    });
});
