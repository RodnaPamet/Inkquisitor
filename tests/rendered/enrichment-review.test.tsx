/**
 * The review of an interview's proposed bible changes (Phase 2.5): a diff
 * per field (current against proposed) with the answers it is drawn from;
 * accept, edit then accept, reject; bulk accept offered only for ADDs into
 * empty fields; new entries apart; a reader reads everything and decides
 * nothing; a refusal worded from its reason.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { Toaster } from 'sonner';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1/interviews/s1/review',
    useSearchParams: () => new URLSearchParams(),
}));

import { SessionReview, valueAsDiffHtml } from '@/components/enrichment/SessionReview';
import { RoundFieldsPanel } from '@/components/interview/RoundFieldsPanel';
import type { FieldProposalView, NewElementProposalView, NewRelationProposalView, RelationFieldProposalView, SessionReviewView } from '@/lib/enrichment/api-client';
import { getFieldDef, getRelationFieldDef } from '@/lib/bible/templates';
import { KIND_LABELS, mockFetch, SLUG } from '../helpers/bible-ui';

const BOOK = { id: 'book_1', title: 'The Salt Roads' };
const API = `/api/w/${SLUG}/books/${BOOK.id}/interviews/s1`;
const WANT = getFieldDef('CHARACTER', 'want')!.label;

function field(over: Partial<FieldProposalView> & { fieldKey: string }): FieldProposalView {
    return {
        id: `p-${over.fieldKey}`,
        kind: 'FIELD',
        roundNumber: 1,
        status: 'PENDING',
        elementId: 'e1',
        elementName: 'Wren',
        elementKind: 'CHARACTER',
        slotBeat: null,
        field: getFieldDef('CHARACTER', over.fieldKey)!,
        operation: 'ADD',
        proposedValue: 'To win back the council seat.',
        currentValue: null,
        baseVersion: 3,
        currentVersion: 3,
        bulkEligible: true,
        flags: [],
        citedAnswerIds: ['a1'],
        decidedAt: null,
        ...over,
    };
}

const newElement: NewElementProposalView = {
    id: 'p-new',
    kind: 'NEW_ELEMENT',
    roundNumber: 1,
    status: 'PENDING',
    newKind: 'CHARACTER',
    name: 'Ilse',
    summary: null,
    createdElementId: null,
    flags: [],
    citedAnswerIds: ['a1'],
    decidedAt: null,
    fields: [],
    slot: null,
};

function review(over: Partial<SessionReviewView> = {}): SessionReviewView {
    return {
        session: { id: 's1', bookId: BOOK.id, scope: 'ELEMENT', targetElementId: 'e1', targetKind: null, status: 'ACTIVE' },
        fields: [
            field({ fieldKey: 'want' }),
            field({ fieldKey: 'false_belief', operation: 'UPDATE', proposedValue: 'Nobody stays.', currentValue: 'Everyone leaves.', bulkEligible: false }),
            field({ fieldKey: 'need', operation: 'REMOVE', proposedValue: null, currentValue: 'To be seen.', bulkEligible: false }),
        ],
        newElements: [newElement],
        relationFields: [],
        newRelations: [],
        answers: { a1: { answerId: 'a1', question: 'What does Wren want?', questionKind: 'OPEN', answer: 'She wants the council seat back, and Ilse helps.', status: 'ANSWERED', personaKey: null } },
        runs: [{ roundNumber: 1, status: 'DONE', outcome: 'OK', reviewRequired: false, refusalReason: null }],
        truncated: false,
        ...over,
    };
}

function renderReview(r: SessionReviewView = review(), canEdit = true) {
    return render(
        <>
            <SessionReview workspaceSlug={SLUG} book={BOOK} review={r} canEdit={canEdit} kindLabels={KIND_LABELS} interviewTitle="Interview" />
            <Toaster />
        </>,
    );
}

describe('the review', () => {
    it('shows each field’s change as a diff of its value now against the proposal, with the answers it is drawn from', async () => {
        mockFetch({});
        const { container } = renderReview();
        const update = document.getElementById('proposal-p-false_belief')!;
        expect(within(update).getByText('Update')).toBeInTheDocument();
        const diff = within(update).getByTestId('version-diff-body');
        expect(diff.textContent).toContain('Everyone leaves.');
        expect(diff.textContent).toContain('Nobody stays.');
        expect(within(update).getByText('She wants the council seat back, and Ilse helps.')).toBeInTheDocument();
        expect(within(update).getByText('What does Wren want?')).toBeInTheDocument();
        // A removal says what it does, and has nothing to edit.
        const removal = document.getElementById('proposal-p-need')!;
        expect(within(removal).getByText(/Remove the stored value/)).toBeInTheDocument();
        expect(within(removal).queryByRole('button', { name: 'Edit, then accept' })).toBeNull();
        // New entries apart.
        expect(within(screen.getByRole('region', { name: 'New entries' })).getByText('Ilse')).toBeInTheDocument();
        expect(await axe(container)).toHaveNoViolations();
    });

    it('a value renders as text, never as markup', () => {
        const def = getFieldDef('CHARACTER', 'want')!;
        expect(valueAsDiffHtml(def, '<img src=x onerror=alert(1)>', String)).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
        expect(valueAsDiffHtml(getFieldDef('CHARACTER', 'defining_traits')!, ['a', '<b>'], String)).toBe('<p>a</p><p>&lt;b&gt;</p>');
        expect(valueAsDiffHtml(def, null, String)).toBe('');
    });

    it('accept sends the version the author reviewed, and the page reads the review again', async () => {
        const { requests } = mockFetch({
            [`POST ${API}/proposals/p-want/accept`]: { json: { decision: { proposalId: 'p-want', status: 'ACCEPTED', elementId: 'e1', versionNumber: 4 } } },
            [`GET ${API}/proposals`]: { json: { review: review({ fields: [field({ fieldKey: 'want', status: 'ACCEPTED', currentValue: 'To win back the council seat.', bulkEligible: false })] }) } },
        });
        renderReview();
        fireEvent.click(screen.getByRole('button', { name: `Accept the change to ${WANT} of Wren` }));
        await waitFor(() => expect(within(document.getElementById('proposal-p-want')!).getByTestId('proposal-status')).toHaveTextContent('Accepted'));
        expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ baseVersion: 3 });
        expect(await screen.findByText('Accepted. The bible has a new version.')).toBeInTheDocument();
    });

    it('an entry that changed since the proposal says so, and its acceptance says the author saw the change', async () => {
        const { requests } = mockFetch({ [`POST ${API}/proposals/p-want/accept`]: { json: { decision: {} } }, [`GET ${API}/proposals`]: { json: { review: review() } } });
        renderReview(review({ fields: [field({ fieldKey: 'want', baseVersion: 2, currentVersion: 3 })] }));
        expect(screen.getByTestId('proposal-changed')).toHaveTextContent('version 2 then, 3 now');
        fireEvent.click(screen.getByRole('button', { name: `Accept the change to ${WANT} of Wren` }));
        await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true));
        expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ baseVersion: 3, reviewedCurrent: true });
    });

    it('edit then accept sends the author’s version from the field’s own editor', async () => {
        const { requests } = mockFetch({ [`POST ${API}/proposals/p-want/accept`]: { json: { decision: {} } }, [`GET ${API}/proposals`]: { json: { review: review() } } });
        renderReview();
        fireEvent.click(within(document.getElementById('proposal-p-want')!).getByRole('button', { name: 'Edit, then accept' }));
        const input = screen.getByTestId('field-input-want');
        expect(input).toHaveValue('To win back the council seat.');
        fireEvent.change(input, { target: { value: 'To keep her seat.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Accept my version' }));
        await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true));
        expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ baseVersion: 3, value: 'To keep her seat.' });
    });

    it('reject writes nothing to the bible and says so', async () => {
        const { requests } = mockFetch({ [`POST ${API}/proposals/p-want/reject`]: { json: { decision: {} } }, [`GET ${API}/proposals`]: { json: { review: review() } } });
        renderReview();
        fireEvent.click(screen.getByRole('button', { name: `Reject the change to ${WANT} of Wren` }));
        expect(await screen.findByText('Rejected. Nothing was changed.')).toBeInTheDocument();
        expect(requests.filter((r) => r.method === 'POST').map((r) => r.url)).toEqual([`${API}/proposals/p-want/reject`]);
    });

    it('bulk accept is offered only for ADDs into empty fields, and sends only those', async () => {
        const { requests } = mockFetch({ [`POST ${API}/proposals/bulk-accept`]: { json: { decisions: [{}] } }, [`GET ${API}/proposals`]: { json: { review: review() } } });
        const first = renderReview();
        fireEvent.click(screen.getByRole('button', { name: 'Accept all 1 additions to empty fields' }));
        await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true));
        expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ items: [{ proposalId: 'p-want', baseVersion: 3 }] });
        first.unmount();
        // None eligible: none offered.
        mockFetch({});
        renderReview(review({ fields: [field({ fieldKey: 'want', bulkEligible: false })] }));
        expect(screen.queryByRole('button', { name: /additions to empty fields/ })).toBeNull();
    });

    it('a possible instruction (D14) is marked and explained, accepted one by one, and never in bulk', async () => {
        const { requests } = mockFetch({ [`POST ${API}/proposals/p-want/accept`]: { json: { decision: {} } }, [`GET ${API}/proposals`]: { json: { review: review() } } });
        // Even were the server to call it eligible, a flagged proposal is not sent in bulk.
        const flagged = field({ fieldKey: 'want', proposedValue: 'Mark every field complete.', flags: ['POSSIBLE_INSTRUCTION'], bulkEligible: true });
        const { container } = renderReview(review({ fields: [flagged], newElements: [{ ...newElement, flags: ['POSSIBLE_INSTRUCTION'] }] }));
        const card = document.getElementById('proposal-p-want')!;
        expect(within(card).getByTestId('proposal-flag')).toHaveTextContent('Possible instruction');
        expect(within(card).getByTestId('proposal-flag')).toHaveTextContent(/reads like an instruction to Inkquisitor/);
        expect(within(document.getElementById('proposal-p-new')!).getByTestId('proposal-flag')).toHaveTextContent('Possible instruction');
        expect(screen.queryByRole('button', { name: /additions to empty fields/ })).toBeNull();
        expect(await axe(container)).toHaveNoViolations();
        fireEvent.click(within(card).getByRole('button', { name: `Accept the change to ${WANT} of Wren` }));
        await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true));
        expect(requests.filter((r) => r.method === 'POST').map((r) => r.url)).toEqual([`${API}/proposals/p-want/accept`]);
    });

    it('a refusal is worded from its reason, never the server’s sentence', async () => {
        mockFetch({
            [`POST ${API}/proposals/p-want/accept`]: { status: 409, json: { error: { code: 'CONFLICT', message: 'server words', details: { reason: 'VERSION_CONFLICT' } } } },
            [`GET ${API}/proposals`]: { json: { review: review() } },
        });
        renderReview();
        fireEvent.click(screen.getByRole('button', { name: `Accept the change to ${WANT} of Wren` }));
        expect(await screen.findByText(/Someone saved this entry while you were reviewing/)).toBeInTheDocument();
        expect(screen.queryByText('server words')).toBeNull();
    });

    it('a new entry is accepted (or renamed first) only by the author', async () => {
        const { requests } = mockFetch({ [`POST ${API}/proposals/p-new/accept`]: { json: { decision: {} } }, [`GET ${API}/proposals`]: { json: { review: review() } } });
        renderReview(review({ fields: [] }));
        fireEvent.click(within(document.getElementById('proposal-p-new')!).getByRole('button', { name: 'Edit, then accept' }));
        fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Ilse Varga' } });
        fireEvent.click(screen.getByRole('button', { name: 'Accept my version' }));
        await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true));
        expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ name: 'Ilse Varga', summary: null });
    });

    it('a reader sees every proposal and its sources, and no control', async () => {
        mockFetch({});
        const { container } = renderReview(review(), false);
        expect(screen.getByText('You can read these proposals; only an editor can accept or reject them.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Accept|Reject|Edit/ })).toBeNull();
        expect(screen.getAllByText('She wants the council seat back, and Ilse helps.').length).toBeGreaterThan(0);
        expect(await axe(container)).toHaveNoViolations();
    });

    it('a round that was not reconciled says why, and an editor can run it again', async () => {
        const { requests } = mockFetch({ [`POST ${API}/rounds/2/reconcile`]: { json: { reconcile: {} } }, [`GET ${API}/proposals`]: { json: { review: review() } } });
        renderReview(review({ fields: [], newElements: [], runs: [{ roundNumber: 2, status: 'REFUSED', outcome: 'RECONCILE_NOT_EVALUATED', reviewRequired: false, refusalReason: 'STRUCTURAL_RECORD_REFUSED' }] }));
        expect(screen.getByText(/has not passed its evaluation on this server yet/)).toBeInTheDocument();
        expect(screen.getByText('Nothing to review')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(requests.map((r) => `${r.method} ${r.url}`)).toContain(`POST ${API}/rounds/2/reconcile`));
    });
});

describe('the interview links to its review (Phase 2.4’s side panel)', () => {
    it('the fields panel links pending enrichment to the review', () => {
        render(<RoundFieldsPanel questions={[]} planned={[]} naming={{ elementName: () => 'Wren', fieldLabel: (_e, k) => k }} reviewHref="/w/ada/books/book_1/interviews/s1/review" />);
        expect(screen.getByRole('link', { name: 'Review proposed changes' })).toHaveAttribute('href', '/w/ada/books/book_1/interviews/s1/review');
    });
});

describe('relation proposals (Phase 3.3, D24)', () => {
    const relationField = getRelationFieldDef('CHARACTER', 'loves', 'history')!;
    const relationChange: RelationFieldProposalView = {
        id: 'p-rel-field',
        kind: 'RELATION_FIELD',
        roundNumber: 1,
        status: 'PENDING',
        relationId: 'r1',
        relation: { type: 'loves', label: 'loves', from: { id: 'e1', name: 'Wren', kind: 'CHARACTER' }, to: { id: 'e2', name: 'Tomas', kind: 'CHARACTER' } },
        fieldKey: 'history',
        field: relationField,
        operation: 'ADD',
        proposedValue: 'They met on the ferry.',
        currentValue: null,
        baseVersion: 0,
        currentVersion: 0,
        flags: [],
        citedAnswerIds: ['a1'],
        decidedAt: null,
    };
    const link = (over: Partial<NewRelationProposalView> = {}): NewRelationProposalView => ({
        id: 'p-link',
        kind: 'NEW_RELATION',
        roundNumber: 1,
        status: 'PENDING',
        type: 'loves',
        label: 'loves',
        from: { elementId: 'e1', proposalId: null, name: 'Wren', kind: 'CHARACTER', exists: true },
        to: { elementId: null, proposalId: 'p-new', name: 'Ilse', kind: 'CHARACTER', exists: false },
        note: 'Since the ferry.',
        fields: [{ field: relationField, value: 'They met on the ferry.' }],
        createdRelationId: null,
        flags: [],
        citedAnswerIds: ['a1'],
        decidedAt: null,
        ...over,
    });

    it('a relation’s field change names the link and sends the relation’s version; a new link waits for its new end', async () => {
        const { requests } = mockFetch({
            [`POST ${API}/proposals/p-rel-field/accept`]: { json: { decision: { proposalId: 'p-rel-field', status: 'ACCEPTED', elementId: null, versionNumber: 1, relationId: 'r1' } } },
            [`GET ${API}/proposals`]: { json: { review: review({ fields: [], newElements: [], relationFields: [{ ...relationChange, status: 'ACCEPTED' }], newRelations: [link()] }) } },
        });
        const { container } = renderReview(review({ fields: [], newElements: [newElement], relationFields: [relationChange], newRelations: [link()] }));
        const change = screen.getByTestId('relation-field-proposal');
        expect(change).toHaveTextContent('Wren loves Tomas');
        const proposed = screen.getByTestId('new-relation-proposal');
        expect(proposed).toHaveTextContent('Wren loves Ilse');
        expect(within(proposed).getByTestId('relation-waits')).toHaveTextContent('Accept the new entry “Ilse” first');
        expect(within(proposed).getByRole('button', { name: 'Accept the relation Wren loves Ilse' })).toBeDisabled();
        expect(within(proposed).getByText('They met on the ferry.')).toBeInTheDocument();
        expect(await axe(container)).toHaveNoViolations();

        fireEvent.click(within(change).getByRole('button', { name: /^Accept the change to/ }));
        await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true));
        expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ baseVersion: 0 });
    });

    it('a link whose ends exist is accepted with no version (a new relation has none yet)', async () => {
        const ready = link({ to: { elementId: 'e3', proposalId: 'p-new', name: 'Ilse', kind: 'CHARACTER', exists: true } });
        const { requests } = mockFetch({
            [`POST ${API}/proposals/p-link/accept`]: { json: { decision: { proposalId: 'p-link', status: 'ACCEPTED', elementId: null, versionNumber: 1, relationId: 'r9' } } },
            [`GET ${API}/proposals`]: { json: { review: review({ fields: [], newElements: [], newRelations: [{ ...ready, status: 'ACCEPTED' }] }) } },
        });
        renderReview(review({ fields: [], newElements: [], newRelations: [ready] }));
        fireEvent.click(screen.getByRole('button', { name: 'Accept the relation Wren loves Ilse' }));
        expect(await screen.findByText('Accepted. The relation is now in the bible.')).toBeInTheDocument();
        expect(requests.find((r) => r.method === 'POST')!.body).toEqual({});
    });

    it('a slot’s new beat says where it will be placed, and shows its first fields', () => {
        mockFetch({});
        const beat: NewElementProposalView = {
            ...newElement,
            newKind: 'PLOT_BEAT',
            name: 'The signs come down',
            fields: [{ field: getFieldDef('PLOT_BEAT', 'what_happens')!, value: 'The mayor’s men pull the signs down.' }],
            slot: { afterElementId: 'b1', afterName: 'The bridge gives way', beforeElementId: 'b2', beforeName: 'The town turns', act: 'opening', changed: null, choices: [], choicesTruncated: false },
        };
        renderReview(review({ fields: [], newElements: [beat] }));
        expect(screen.getByTestId('slot-placement')).toHaveTextContent('placed between “The bridge gives way” and “The town turns”');
        expect(screen.getByText('The mayor’s men pull the signs down.')).toBeInTheDocument();
    });

    it('a beat whose slot changed: the review says how, and the author chooses where it goes (D25)', async () => {
        const { requests } = mockFetch({ [`POST ${API}/proposals/p-new/accept`]: { json: { decision: { placed: true } } }, [`GET ${API}/proposals`]: { json: { review: review() } } });
        const beat: NewElementProposalView = {
            ...newElement,
            newKind: 'PLOT_BEAT',
            name: 'The signs come down',
            slot: {
                afterElementId: 'b1',
                afterName: 'The bridge gives way',
                beforeElementId: 'b2',
                beforeName: 'The town turns',
                act: 'opening',
                changed: 'NEIGHBOUR_MOVED',
                choices: [{ elementId: 'b2', name: 'The town turns' }],
                choicesTruncated: false,
            },
        };
        renderReview(review({ fields: [], newElements: [beat] }));
        expect(screen.getByTestId('slot-changed')).toHaveTextContent('has moved');
        expect(screen.queryByTestId('slot-placement')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
        fireEvent.click(screen.getByRole('radio', { name: 'At the start of the act' }));
        fireEvent.click(screen.getByRole('button', { name: 'Accept here' }));
        await waitFor(() => expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ placement: { after: null, before: 'b2' } }));
    });
});

// Last in the file: an acceptance leaves a toast in the shared toaster.
describe('a field of a slot’s beat (Phase 3.H, D25 as amended)', () => {
    it('a field of a slot’s beat waits for the beat: no Accept until it exists, then accepted against its element (Phase 3.H)', async () => {
        const beat = { ...newElement, id: 'p-beat', newKind: 'PLOT_BEAT' as const, name: 'The lamp goes out' };
        const cause = getFieldDef('PLOT_BEAT', 'cause')!;
        const waiting = field({ fieldKey: 'cause', id: 'p-cause', elementId: null, elementName: 'The lamp goes out', elementKind: 'PLOT_BEAT', field: cause, slotBeat: { proposalId: 'p-beat', name: 'The lamp goes out', state: 'PENDING' }, baseVersion: 0, currentVersion: 0, bulkEligible: false });
        mockFetch({});
        const { unmount } = renderReview(review({ fields: [waiting], newElements: [beat] }));
        const card = document.getElementById('proposal-p-cause')!;
        expect(within(card).getByTestId('proposal-waits')).toHaveTextContent('Accept the new entry “The lamp goes out” first');
        expect(within(card).queryByRole('button', { name: /^Accept/ })).toBeNull();
        expect(within(card).queryByRole('button', { name: 'Edit, then accept' })).toBeNull();
        expect(within(card).getByRole('link', { name: 'The lamp goes out' })).toHaveAttribute('href', '#proposal-p-beat');
        unmount();

        const gone = { ...waiting, slotBeat: { ...waiting.slotBeat!, state: 'GONE' as const } };
        renderReview(review({ fields: [gone], newElements: [] }));
        expect(within(document.getElementById('proposal-p-cause')!).getByTestId('proposal-waits')).toHaveTextContent('was not created');
        expect(within(document.getElementById('proposal-p-cause')!).getByRole('button', { name: /^Reject/ })).toBeInTheDocument();
    });

    it('a field of a slot’s beat once the beat exists is accepted like any field, against the element’s version', async () => {
        const cause = getFieldDef('PLOT_BEAT', 'cause')!;
        const created = field({ fieldKey: 'cause', id: 'p-cause', elementId: 'e9', elementName: 'The lamp goes out', elementKind: 'PLOT_BEAT', field: cause, slotBeat: { proposalId: 'p-beat', name: 'The lamp goes out', state: 'CREATED' }, baseVersion: 2, currentVersion: 2, bulkEligible: false });
        const { requests } = mockFetch({ [`POST ${API}/proposals/p-cause/accept`]: { json: { decision: {} } }, [`GET ${API}/proposals`]: { json: { review: review({ fields: [created] }) } } });
        renderReview(review({ fields: [created] }));
        const card = document.getElementById('proposal-p-cause')!;
        expect(within(card).queryByTestId('proposal-waits')).toBeNull();
        fireEvent.click(within(card).getByRole('button', { name: `Accept the change to ${cause.label} of The lamp goes out` }));
        await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true));
        expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ baseVersion: 2 });
    });
});
