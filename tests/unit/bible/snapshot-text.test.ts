/**
 * A version snapshot as readable diff lines (Phase 1.2): labels, never keys
 * or JSON; a choice by its option's label; an author's markup kept as text.
 */
import { htmlToLines } from '@/components/ui/VersionDiff';
import { snapshotToDiffHtml } from '@/lib/bible/snapshot-text';
import { getTemplate } from '@/lib/bible/templates';

const labels = {
    name: 'Name',
    customLabel: 'Custom kind',
    status: 'Status',
    summary: 'Summary',
    statusValue: (s: string) => (s === 'DRAFT' ? 'Draft' : s),
    scaleValue: (v: number) => `${v} of 5`,
};

it('renders the element and every filled field under its template label, in template order', () => {
    const html = snapshotToDiffHtml(
        {
            format: 1,
            element: { kind: 'CHARACTER', name: 'Mara', slug: 'mara', status: 'DRAFT', summary: 'Line one\nLine two', customLabel: null },
            fields: [
                { key: 'role', order: 1, value: 'Ferrywoman <b>x</b>' },
                { key: 'prominence', order: 2, value: 'major' },
                { key: 'defining_traits', order: 3, value: ['stubborn', 'kind'] },
                { key: 'agency', order: 8, value: 4 },
                { key: 'wound', order: 9, value: '<p>Lost the boat</p><p>And the map</p>' },
                { key: 'retired_key', order: 99, value: 'kept' },
            ],
        },
        getTemplate('CHARACTER').fields,
        labels,
    );
    expect(htmlToLines(html).split('\n')).toEqual([
        'Name: Mara',
        'Status: Draft',
        'Summary:',
        'Line one',
        'Line two',
        'Role in the story: Ferrywoman <b>x</b>',
        'Prominence: Major presence',
        'Defining traits:',
        '• stubborn',
        '• kind',
        'Drive to act: 4 of 5',
        'Formative wound:',
        'Lost the boat',
        'And the map',
        'retired_key: kept',
    ]);
});

it('keeps a rich-text value that is bare inline text on lines of its own', () => {
    // The API stores rich text that is not wrapped in a block as it is.
    const html = snapshotToDiffHtml(
        {
            format: 1,
            element: { kind: 'CHARACTER', name: 'Mara', slug: 'mara', status: 'DRAFT', summary: null, customLabel: null },
            fields: [
                { key: 'wound', order: 9, value: 'Lost the <em>boat</em> &amp; the &lt;map&gt;' },
                { key: 'false_belief', order: 10, value: 'Nobody waits' },
            ],
        },
        getTemplate('CHARACTER').fields,
        labels,
    );
    expect(htmlToLines(html).split('\n')).toEqual([
        'Name: Mara',
        'Status: Draft',
        'Formative wound:',
        'Lost the boat & the <map>',
        expect.stringMatching(/: Nobody waits$/),
    ]);
});
