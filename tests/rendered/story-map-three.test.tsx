/**
 * The three maps' parts outside the editor (Phase 3.2): the type picker, the
 * element sheet and the read-only embedded view. Each is driven by keyboard
 * where a person would, and checked with axe.
 */
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1/maps/relationship',
}));

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { clearHeldEditsForTests } from '@/components/bible/use-element-autosave';
import { ElementSheet } from '@/components/canvas/ElementSheet';
import { RelationTypePicker } from '@/components/canvas/RelationTypePicker';
import { StoryMapPreview } from '@/components/canvas/StoryMapPreview';
import { fieldDefsFor, relationOptionsFor } from '@/lib/bible/ui-model';
import type { StoryMapView } from '@/lib/canvas/api-client';
import { relationPickerChoices } from '@/lib/canvas/relation-picker';
import { API, BOOK, KIND_LABELS, SLUG, elementView, mockFetch } from '../helpers/bible-ui';

describe('RelationTypePicker', () => {
    const choices = relationPickerChoices({ a: { id: 'guild', kind: 'FACTION' }, b: { id: 'mara', kind: 'CHARACTER' } }, relationOptionsFor('FACTION'), []);

    it('offers only what the two kinds declare (and related to), as sentences, and creates the chosen one from its declaring end', async () => {
        const { requests } = mockFetch({
            [`POST ${API}/relations`]: { status: 201, json: { relation: { id: 'rel_9', fromElementId: 'mara', toElementId: 'guild', type: 'member_of', label: 'member of', inverseLabel: 'has member', note: null } } },
        });
        const onCreated = jest.fn();
        render(<RelationTypePicker open workspaceSlug={SLUG} bookId={BOOK.id} names={{ a: 'The Guild', b: 'Mara' }} choices={choices} onCreated={onCreated} onCancel={jest.fn()} />);
        const group = screen.getByRole('radiogroup', { name: 'Relation' });
        const labels = within(group).getAllByRole('radio').map((r) => document.querySelector(`label[for="${r.id}"]`)!.textContent);
        expect(labels).toEqual(['The Guild allied with Mara', 'The Guild opposed by Mara', 'The Guild has authority over Mara', 'The Guild has member Mara', 'The Guild related to Mara']);
        // By keyboard: the arrows move the choice (a radio group is one tab stop), the form submits.
        const user = userEvent.setup();
        within(group).getAllByRole('radio')[0].focus();
        // Held, then released: the radio follows focus while an arrow is down (as in a browser).
        for (let i = 0; i < 3; i++) {
            await user.keyboard('{ArrowDown>}');
            await act(() => new Promise((r) => setTimeout(r, 5)));
            await user.keyboard('{/ArrowDown}');
        }
        expect(within(group).getByRole('radio', { name: 'The Guild has member Mara' })).toHaveAttribute('aria-checked', 'true');
        await user.tab();
        await user.tab();
        expect(screen.getByRole('button', { name: 'Relate them' })).toHaveFocus();
        await user.keyboard('{Enter}');
        await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
        expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ fromElementId: 'mara', toElementId: 'guild', type: 'member_of' });
        expect(await axe(document.body)).toHaveNoViolations();
    });

    it('words a refusal from its reason and keeps the dialog open; Cancel calls back', async () => {
        mockFetch({ [`POST ${API}/relations`]: { status: 409, json: { error: { code: 'CONFLICT', message: 'Server words', details: { reason: 'RELATION_EXISTS' } } } } });
        const onCancel = jest.fn();
        render(<RelationTypePicker open workspaceSlug={SLUG} bookId={BOOK.id} names={{ a: 'The Guild', b: 'Mara' }} choices={choices} onCreated={jest.fn()} onCancel={onCancel} />);
        fireEvent.click(screen.getByRole('button', { name: 'Relate them' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('These two entries are already related that way.');
        expect(document.body).not.toHaveTextContent('Server words');
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('with nothing left to make, says so and offers no submit', () => {
        render(<RelationTypePicker open workspaceSlug={SLUG} bookId={BOOK.id} names={{ a: 'A', b: 'B' }} choices={[]} onCreated={jest.fn()} onCancel={jest.fn()} />);
        expect(screen.getByTestId('relation-type-picker-none')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Relate them' })).toBeDisabled();
    });
});

describe('ElementSheet', () => {
    beforeEach(() => clearHeldEditsForTests());
    const EL = `${API}/elements/el_1`;
    const fieldDefs = { CHARACTER: fieldDefsFor('CHARACTER'), PLOT_BEAT: fieldDefsFor('PLOT_BEAT') };

    it('reads the element fresh, shows its completeness, and saves a field through the versioned save', async () => {
        const saved = elementView({ versionNumber: 4, values: { role: 'Lead', want: 'Home' } });
        const { requests } = mockFetch({
            [`GET ${EL}`]: { json: { element: elementView({ versionNumber: 3, values: { role: 'Lead' } }) } },
            [`PUT ${EL}/fields`]: { json: { element: { ...saved, changedKeys: ['want'] } } },
        });
        const onSaved = jest.fn();
        render(<ElementSheet open onOpenChange={jest.fn()} workspaceSlug={SLUG} bookId={BOOK.id} elementId="el_1" fieldDefs={fieldDefs} kindLabels={KIND_LABELS} canEdit onSaved={onSaved} />);
        await screen.findByTestId('element-sheet-body');
        expect(screen.getByText(/1 of 14 fields filled/)).toBeInTheDocument();
        const want = screen.getByRole('textbox', { name: /Conscious want/ });
        fireEvent.change(want, { target: { value: 'Home' } });
        await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1), { timeout: 3000 });
        const put = requests.find((r) => r.method === 'PUT')!;
        expect(put.body).toMatchObject({ baseVersion: 3, fields: [{ key: 'want', value: 'Home' }] });
        expect(screen.getByRole('link', { name: 'Open the full page' })).toHaveAttribute('href', `/w/${SLUG}/books/${BOOK.id}/elements/el_1`);
        expect(await axe(document.body)).toHaveNoViolations();
    });

    it('a reader sees values as text, and no control', async () => {
        mockFetch({ [`GET ${EL}`]: { json: { element: elementView({ values: { role: 'Lead' } }) } } });
        render(<ElementSheet open onOpenChange={jest.fn()} workspaceSlug={SLUG} bookId={BOOK.id} elementId="el_1" fieldDefs={fieldDefs} kindLabels={KIND_LABELS} canEdit={false} />);
        await screen.findByTestId('element-sheet-body');
        expect(screen.getByText('Lead')).toBeInTheDocument();
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Earlier' })).not.toBeInTheDocument();
    });

    it('an element deleted meanwhile says so', async () => {
        mockFetch({});
        render(<ElementSheet open onOpenChange={jest.fn()} workspaceSlug={SLUG} bookId={BOOK.id} elementId="el_1" fieldDefs={fieldDefs} kindLabels={KIND_LABELS} canEdit />);
        expect(await screen.findByTestId('element-sheet-failed')).toHaveTextContent('no longer in the bible');
    });

    it('a conflict: closing keeps the edits, reopening SHOWS them, and "Reload theirs" drops them for the saved version', async () => {
        const conflict = { status: 409, json: { error: { code: 'CONFLICT', message: 'x', details: { reason: 'VERSION_CONFLICT', currentVersion: 5, baseVersion: 3 } } } };
        const { requests } = mockFetch({
            [`GET ${EL}`]: { json: { element: elementView({ versionNumber: 3, values: { want: 'Theirs' } }) } },
            [`PUT ${EL}/fields`]: conflict,
        });
        const sheet = (open: boolean) => (
            <ElementSheet open={open} onOpenChange={jest.fn()} workspaceSlug={SLUG} bookId={BOOK.id} elementId={open ? 'el_1' : null} fieldDefs={fieldDefs} kindLabels={KIND_LABELS} canEdit />
        );
        const { rerender } = render(sheet(true));
        await screen.findByTestId('element-sheet-body');
        fireEvent.change(screen.getByRole('textbox', { name: /Conscious want/ }), { target: { value: 'Mine' } });
        await screen.findByTestId('element-sheet-conflict', {}, { timeout: 3000 });

        // Closed and opened again: the held edit is what the box shows, not the saved value it would overwrite.
        rerender(sheet(false));
        mockFetch({ [`GET ${EL}`]: { json: { element: elementView({ versionNumber: 5, values: { want: 'Theirs' } }) } }, [`PUT ${EL}/fields`]: conflict });
        rerender(sheet(true));
        await screen.findByTestId('element-sheet-body');
        expect(screen.getByTestId('element-sheet-conflict')).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: /Conscious want/ })).toHaveValue('Mine');

        // Their version instead: the held edit is gone, the box shows theirs, and nothing is sent.
        const { requests: after } = mockFetch({ [`GET ${EL}`]: { json: { element: elementView({ versionNumber: 5, values: { want: 'Theirs' } }) } } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Reload their version' }));
        });
        await waitFor(() => expect(screen.queryByTestId('element-sheet-conflict')).not.toBeInTheDocument());
        expect(screen.getByRole('textbox', { name: /Conscious want/ })).toHaveValue('Theirs');
        expect(after.filter((r) => r.method === 'PUT')).toHaveLength(0);
        // The next edit is based on their version.
        const { requests: next } = mockFetch({ [`PUT ${EL}/fields`]: { json: { element: { ...elementView({ versionNumber: 6, values: { want: 'Again' } }), changedKeys: ['want'] } } } });
        fireEvent.change(screen.getByRole('textbox', { name: /Conscious want/ }), { target: { value: 'Again' } });
        await waitFor(() => expect(next.filter((r) => r.method === 'PUT')).toHaveLength(1), { timeout: 3000 });
        expect(next[0].body).toMatchObject({ baseVersion: 5, fields: [{ key: 'want', value: 'Again' }] });
        expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    });

    it('moves the element in its order by keyboard: unsaved edits first, then the move, whose version is the next save’s base', async () => {
        const beat = elementView({ kind: 'PLOT_BEAT', versionNumber: 2, values: { act: 'opening' } });
        const { requests } = mockFetch({
            [`GET ${EL}`]: { json: { element: beat } },
            [`PUT ${EL}/fields`]: { json: { element: { ...beat, versionNumber: 3, changedKeys: ['reader_takeaway'] } } },
        });
        const move = jest.fn(async () => 4);
        render(
            <ElementSheet
                open
                onOpenChange={jest.fn()}
                workspaceSlug={SLUG}
                bookId={BOOK.id}
                elementId="el_1"
                fieldDefs={fieldDefs}
                kindLabels={KIND_LABELS}
                canEdit
                order={{ canEarlier: true, canLater: false, move }}
            />,
        );
        await screen.findByTestId('element-sheet-body');
        expect(screen.getByRole('button', { name: 'Later' })).toBeDisabled();
        fireEvent.change(screen.getByRole('textbox', { name: /What the reader is left with/ }), { target: { value: 'Will she go back?' } });
        const earlier = screen.getByRole('button', { name: 'Earlier' });
        earlier.focus();
        await act(async () => {
            fireEvent.click(earlier);
        });
        await waitFor(() => expect(move).toHaveBeenCalledWith('earlier', 3));
        // The edit was saved before the move was asked for.
        expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
        fireEvent.change(screen.getByRole('textbox', { name: /What the reader is left with/ }), { target: { value: 'Will she ever go back?' } });
        await waitFor(() => expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(2), { timeout: 3000 });
        expect(requests.filter((r) => r.method === 'PUT')[1].body).toMatchObject({ baseVersion: 4 });
    });
});

describe('StoryMapPreview', () => {
    const node = (elementId: string, name: string, kind: StoryMapView['nodes'][number]['element']['kind'], x: number, extra: Partial<StoryMapView['nodes'][number]['element']> = {}) => ({
        elementId,
        x,
        y: 0,
        w: 220,
        h: 88,
        lane: null,
        element: { name, kind, customLabel: null, filledFieldCount: 1, fieldCount: 14, orderRank: null, act: null, storyTime: null, versionNumber: 1, ...extra },
    });
    const map = (over: Partial<StoryMapView> = {}): StoryMapView =>
        ({
            kind: 'RELATIONSHIP',
            version: 3,
            nodes: [node('mara', 'Mara', 'CHARACTER', 0), node('guild', 'The Guild', 'FACTION', 400)],
            edges: [{ relationId: 'r1', sourceElementId: 'mara', targetElementId: 'guild', type: 'member_of', label: 'member of' }],
            freeform: [],
            relations: [],
            relationsTruncated: false,
            excludedNodes: 0,
            acts: [],
            participants: [],
            participantsTruncated: false,
            ...over,
        }) as StoryMapView;

    it('draws the map read-only with the page’s element marked; every node is a keyboard-reachable link to its page', async () => {
        render(<StoryMapPreview workspaceSlug={SLUG} bookId={BOOK.id} mapKind="RELATIONSHIP" map={map()} currentElementId="mara" kindLabels={KIND_LABELS} />);
        const marked = screen.getByRole('link', { name: /^Mara Character/ });
        expect(marked).toHaveAttribute('aria-current', 'true');
        expect(marked).toHaveAttribute('href', `/w/${SLUG}/books/${BOOK.id}/elements/mara`);
        expect(screen.getByRole('link', { name: /^The Guild Faction/ })).not.toHaveAttribute('aria-current');
        expect(screen.getByRole('link', { name: 'Open the Relationship map' })).toHaveAttribute('href', `/w/${SLUG}/books/${BOOK.id}/maps/relationship`);
        expect(document.querySelectorAll('line')).toHaveLength(1);
        // No control that edits: a reader and an editor see the same picture.
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(await axe(document.body)).toHaveNoViolations();
    });

    it('says when the element is not on the map yet, and when the map is empty', () => {
        const { rerender } = render(<StoryMapPreview workspaceSlug={SLUG} bookId={BOOK.id} mapKind="RELATIONSHIP" map={map()} currentElementId="someone-else" kindLabels={KIND_LABELS} />);
        expect(screen.getByText('Not on the Relationship map yet.')).toBeInTheDocument();
        rerender(<StoryMapPreview workspaceSlug={SLUG} bookId={BOOK.id} mapKind="RELATIONSHIP" map={map({ nodes: [], edges: [] })} currentElementId="mara" kindLabels={KIND_LABELS} />);
        expect(screen.getByText('The Relationship map is empty.')).toBeInTheDocument();
    });

    it('the timeline shows its lanes behind the events: the axis and a lane per character taking part', () => {
        const timeline = map({
            kind: 'TIMELINE',
            nodes: [node('e1', 'Flood', 'TIMELINE_EVENT', 180, { orderRank: 'i' }), node('e2', 'Fair', 'TIMELINE_EVENT', 400)],
            edges: [],
            participants: [{ eventId: 'e1', characterId: 'mara', characterName: 'Mara' }],
        });
        render(<StoryMapPreview workspaceSlug={SLUG} bookId={BOOK.id} mapKind="TIMELINE" map={timeline} currentElementId="e1" kindLabels={KIND_LABELS} />);
        const svg = screen.getByRole('group', { name: /Timeline/ });
        expect(svg).toHaveTextContent('Story order');
        expect(svg).toHaveTextContent('Not placed yet');
        expect(svg).toHaveTextContent('Mara');
        expect(svg.querySelectorAll('circle')).toHaveLength(1);
    });
});
