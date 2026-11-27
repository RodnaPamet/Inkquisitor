/**
 * "Draft vs bible" on the Continuity page and the scene card in the editor's panel (Phase 5.3, D35), rendered: a
 * manuscript never read says "not read yet" (rule 6); the three choices; "Update the bible" opens the field PREFILLED
 * and sends nothing until the author saves; "Both are true" needs an explanation; a reader reads and decides nothing;
 * the card saves only on Save, naming its version.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { Toaster } from 'sonner';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1/continuity',
    useSearchParams: () => new URLSearchParams(),
}));

import { DraftAgainstBible, type DraftAgainstBibleProps } from '@/components/continuity/DraftAgainstBible';
import { SceneCardPanel } from '@/components/manuscript/SceneCardPanel';
import { SceneDraftPanel } from '@/components/manuscript/SceneDraftPanel';
import type { SceneDraftNotesView } from '@/lib/draft-facts/api-client';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import type { DraftMismatchView, DraftUpdatePrefillView } from '@/lib/draft-facts/vocabulary';
import { SCENE_CARD_FIELDS } from '@/lib/manuscript/scene-card';
import { mockFetch } from '../helpers/bible-ui';

const API = '/api/w/ada/books/book_1';

const MISMATCH: DraftMismatchView = {
    id: 'm1',
    status: 'PENDING',
    kind: 'VALUE',
    createdAt: '2026-11-27T03:10:00.000Z',
    sceneId: 'sc1',
    sceneTitle: 'The lamp',
    draft: { statement: 'Mara has blue eyes.', quote: 'Mara’s blue eyes', subjectName: 'Mara', predicate: 'APPEARANCE', start: 10, end: 26, live: true },
    bible: { statement: 'Mara has green eyes.', quote: 'Mara has green eyes', subjectName: 'Mara', predicate: 'APPEARANCE', elementId: 'el_mara', elementName: 'Mara', versionNumber: 2, live: true },
    canUpdateBible: true,
    explanation: null,
};

const PREFILL: DraftUpdatePrefillView = {
    proposalId: 'm1',
    elementId: 'el_mara',
    elementName: 'Mara',
    fieldKey: 'physical_presence',
    fieldLabel: 'Physical presence',
    fieldType: 'text',
    field: { key: 'physical_presence', label: 'Physical presence', help: 'How they look.', type: 'text', required: false, order: 1, dependsOn: [] },
    baseVersion: 2,
    current: 'Mara has green eyes.',
    prefill: 'Mara has blue eyes.',
    prefillBasis: 'REPLACED',
    draftQuote: 'Mara’s blue eyes',
    sceneId: 'sc1',
    sceneTitle: 'The lamp',
};

function draft(over: Partial<DraftAgainstBibleProps['draft']> = {}): DraftAgainstBibleProps['draft'] {
    return {
        reading: { scenesWithText: 3, scenesRead: 3, scenesWaiting: 0, scenesPassedOver: 0, lastRunAt: '2026-11-27T03:10:00.000Z', lastOutcome: 'OK' },
        mismatches: { items: [MISMATCH], open: 1, truncated: false },
        linkProposals: {
            items: [{ id: 'l1', threadId: 't1', threadTitle: 'Key to the lamp room', threadKind: 'PROMISE', sceneId: 'sc1', sceneTitle: 'The lamp', role: 'PLANTS', status: 'PENDING', quote: 'She promised to find the key.', start: 0, end: 29, flags: [], createdAt: '2026-11-27T03:10:00.000Z' }],
            pending: 1,
            truncated: false,
        },
        ...over,
    };
}

function mount(d: DraftAgainstBibleProps['draft'], canEdit = true) {
    const run = jest.fn(async (work: () => Promise<unknown>) => {
        await work();
        return true;
    });
    const view = render(
        <KeyboardShortcutProvider>
            <DraftAgainstBible workspaceSlug="ada" bookId="book_1" canEdit={canEdit} draft={d} run={run} reasonText={() => 'refused'} />
            <Toaster />
        </KeyboardShortcutProvider>,
    );
    return { ...view, run };
}

describe('Draft vs bible', () => {
    it('a manuscript never read says "not read yet", never "no mismatches" (rule 6)', () => {
        mockFetch({});
        mount(draft({ reading: { scenesWithText: 4, scenesRead: 0, scenesWaiting: 4, scenesPassedOver: 0, lastRunAt: null, lastOutcome: null }, mismatches: { items: [], open: 0, truncated: false }, linkProposals: { items: [], pending: 0, truncated: false } }));
        expect(screen.getByTestId('draft-reading')).toHaveTextContent('Not read yet');
        expect(screen.getAllByText('Not read yet').length).toBeGreaterThan(0);
        expect(screen.queryByText(/No mismatches/)).toBeNull();
        expect(screen.queryByText(/No open mismatches/)).toBeNull();
    });

    it('a mismatch cites both sentences and offers the three choices to an editor; a reader gets none', () => {
        mockFetch({});
        const { unmount } = mount(draft());
        const card = screen.getByTestId('draft-mismatch');
        expect(card).toHaveTextContent('Mara’s blue eyes');
        expect(card).toHaveTextContent('Mara has green eyes');
        expect(within(card).getByTestId('draft-fix')).toBeInTheDocument();
        expect(within(card).getByTestId('draft-update-bible')).toBeInTheDocument();
        expect(within(card).getByTestId('draft-both-true')).toBeInTheDocument();
        unmount();
        mount(draft(), false);
        expect(screen.queryByTestId('draft-fix')).toBeNull();
        expect(screen.queryByTestId('draft-update-bible')).toBeNull();
        expect(screen.queryByTestId('draft-link-confirm')).toBeNull();
    });

    it('"Update the bible" opens the field prefilled and sends nothing until the author saves; the save names the version', async () => {
        const { requests } = mockFetch({
            [`GET ${API}/draft-mismatches/m1/update-bible`]: { json: { prefill: PREFILL } },
            [`POST ${API}/draft-mismatches/m1/update-bible`]: { json: { update: { versionNumber: 3 } } },
        });
        const { run } = mount(draft());
        fireEvent.click(screen.getByTestId('draft-update-bible'));
        const sheet = await screen.findByTestId('draft-update-sheet');
        const field = within(sheet).getByRole('textbox') as HTMLInputElement | HTMLTextAreaElement;
        expect(field.value).toBe('Mara has blue eyes.');
        expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
        fireEvent.change(field, { target: { value: 'Mara has blue eyes, grey at dusk.' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save to the bible' }));
        });
        await waitFor(() => expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1));
        expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ baseVersion: 2, value: 'Mara has blue eyes, grey at dusk.' });
        expect(run).toHaveBeenCalled();
    });

    it('"Both are true" will not save without an explanation', async () => {
        const { requests } = mockFetch({ [`POST ${API}/draft-mismatches/m1/decision`]: { json: { mismatch: { id: 'm1', status: 'KEPT' } } } });
        mount(draft());
        fireEvent.click(screen.getByTestId('draft-both-true'));
        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
        });
        expect(screen.getByText('Say how both can be true.')).toBeInTheDocument();
        expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
        fireEvent.change(screen.getByLabelText(/Explanation/), { target: { value: 'Lamplight changes them.' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        });
        await waitFor(() => expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ decision: 'BOTH_TRUE', explanation: 'Lamplight changes them.' }));
    });

    it('a proposed plant is confirmed by the author', async () => {
        const { requests } = mockFetch({ [`POST ${API}/thread-scene-links/l1/decision`]: { json: { link: { id: 'l1', status: 'CONFIRMED' } } } });
        mount(draft());
        expect(screen.getByTestId('draft-link-proposal')).toHaveTextContent('Plants “Key to the lamp room”');
        await act(async () => {
            fireEvent.click(screen.getByTestId('draft-link-confirm'));
        });
        await waitFor(() => expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ decision: 'CONFIRM' }));
    });

    it('has no accessibility violations', async () => {
        mockFetch({});
        const { container } = mount(draft());
        expect(await axe(container)).toHaveNoViolations();
    });
});

describe('the scene card', () => {
    const CARD = { sceneId: 'sc1', goal: 'Find the key.', conflict: null, outcome: null, change: null, version: 1, versions: [{ versionNumber: 1, source: 'MANUAL' as const, createdAt: '2026-11-27T10:00:00.000Z' }] };

    it('loads the card, saves only on Save naming its version, and offers "Grill me on this scene"', async () => {
        const { requests } = mockFetch({
            [`GET ${API}/manuscript/scenes/sc1/card`]: { json: { card: CARD } },
            [`PUT ${API}/manuscript/scenes/sc1/card`]: { json: { card: { ...CARD, conflict: 'The stair is out.', version: 2 } } },
        });
        render(<SceneCardPanel workspaceSlug="ada" bookId="book_1" sceneId="sc1" canEdit />);
        const goal = (await screen.findByDisplayValue('Find the key.')) as HTMLTextAreaElement;
        expect(goal).toBeInTheDocument();
        expect(screen.getAllByRole('textbox')).toHaveLength(SCENE_CARD_FIELDS.length);
        expect(screen.getByTestId('scene-grill').getAttribute('href')).toContain('scope=SCENE');
        expect(screen.getByTestId('scene-grill').getAttribute('href')).toContain('scene=sc1');
        fireEvent.change(screen.getByLabelText(/Conflict/), { target: { value: 'The stair is out.' } });
        expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save card' }));
        });
        await waitFor(() => expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({ baseVersion: 1, goal: 'Find the key.', conflict: 'The stair is out.', outcome: null, change: null }));
    });

    it('a card saved elsewhere is not overwritten: the author is asked to reload', async () => {
        mockFetch({
            [`GET ${API}/manuscript/scenes/sc1/card`]: { json: { card: CARD } },
            [`PUT ${API}/manuscript/scenes/sc1/card`]: { status: 409, json: { error: { code: 'CONFLICT', message: 'x', details: { reason: 'VERSION_CONFLICT', currentVersion: 2 } } } },
        });
        render(<SceneCardPanel workspaceSlug="ada" bookId="book_1" sceneId="sc1" canEdit />);
        fireEvent.change(await screen.findByDisplayValue('Find the key.'), { target: { value: 'Lose the key.' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save card' }));
        });
        expect(await screen.findByTestId('scene-card-conflict')).toBeInTheDocument();
    });

    it('a reader reads the card as text', async () => {
        mockFetch({ [`GET ${API}/manuscript/scenes/sc1/card`]: { json: { card: CARD } } });
        render(<SceneCardPanel workspaceSlug="ada" bookId="book_1" sceneId="sc1" canEdit={false} />);
        expect(await screen.findByTestId('scene-card-value-goal')).toHaveTextContent('Find the key.');
        expect(screen.queryByRole('textbox')).toBeNull();
        expect(screen.queryByTestId('scene-grill')).toBeNull();
    });
});

describe('the scene editor’s "Draft vs bible" panel (rule 6)', () => {
    const base: SceneDraftNotesView = { readAtCurrentText: true, everRead: true, readOutcome: 'OK', passedOver: false, mismatches: [], currentTextKeyMatches: {}, links: [], truncated: false };
    const panel = (notes: SceneDraftNotesView) =>
        render(<SceneDraftPanel workspaceSlug="ada" bookId="book_1" canEdit notes={notes} loadError={false} placedIds={[]} activeId={null} onReveal={jest.fn()} onFixDraft={jest.fn()} onLink={jest.fn()} />);

    it('a text read with nothing at odds says so; a text passed over never says "no mismatches"', () => {
        const { unmount } = panel(base);
        expect(screen.getByTestId('scene-draft-status')).toHaveTextContent('No mismatches with the bible in this scene.');
        unmount();
        panel({ ...base, readAtCurrentText: false, readOutcome: 'GUARD_REFUSED', passedOver: true });
        expect(screen.getByTestId('scene-draft-status')).toHaveTextContent(/could not be read overnight/);
        expect(screen.getByTestId('scene-draft-status')).not.toHaveTextContent(/No mismatches/);
    });
});
