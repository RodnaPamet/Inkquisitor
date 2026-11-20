/**
 * A small bible as bundle data (Phase 1.3): every field type (text, rich
 * text, list, choice, scale), a CUSTOM element, a summary with paragraphs,
 * and relations of a directed and a symmetric type with and without notes.
 */
import type { BibleBundle } from '@/lib/bible/bundle-format';

export function sampleBundle(): BibleBundle {
    return {
        book: { title: 'The Salt Roads', logline: 'A ferrywoman crosses a drowned country.\n\nShe carries a debt.', genre: 'Fantasy', audience: null, targetLength: 90_000, stage: 'PLANNING' },
        elements: [
            {
                kind: 'FACTION',
                name: 'The Salt Guild',
                slug: 'salt-guild',
                status: 'IN_PROGRESS',
                customLabel: null,
                orderRank: null,
                summary: null,
                fields: new Map<string, string | number | string[]>([
                    ['purpose', 'Keep the ferries taxed'],
                    ['reach', 4],
                ]),
                relations: [],
            },
            {
                kind: 'CHARACTER',
                name: 'Mara Vell',
                slug: 'mara-vell',
                status: 'DRAFT',
                customLabel: null,
                orderRank: null,
                summary: 'A ferrywoman.\n\nShe owes the guild & fears the "water".',
                fields: new Map<string, string | number | string[]>([
                    ['role', 'Lead'],
                    ['prominence', 'carries_book'],
                    ['defining_traits', ['stubborn', 'dry-witted', '#first']],
                    ['speaking_voice', '<p>Short <strong>clipped</strong> sentences &amp; no small talk.</p><ul><li><p>never swears</p></li></ul>'],
                    ['agency', 3],
                ]),
                relations: [
                    { type: 'member_of', to: 'salt-guild', note: 'Reluctantly' },
                    { type: 'sibling_of', to: 'tam-vell', note: null },
                ],
            },
            {
                kind: 'CHARACTER',
                name: 'Tam Vell',
                slug: 'tam-vell',
                status: 'SETTLED',
                customLabel: null,
                orderRank: null,
                summary: null,
                fields: new Map(),
                relations: [],
            },
            {
                kind: 'CUSTOM',
                name: 'Tide tables',
                slug: 'tide-tables',
                status: 'DRAFT',
                customLabel: 'Almanac',
                orderRank: null,
                summary: null,
                fields: new Map<string, string | number | string[]>([
                    ['purpose', 'When the roads flood'],
                    ['key_details', ['Spring tides', 'Neap tides']],
                ]),
                relations: [],
            },
        ],
    };
}
