/**
 * The list beside a story map (Phase 3.3, D24) — THE RECORD of the book's
 * pending new elements and relations — and a relation opened in its sheet.
 *
 *   the list   every pending proposal as text with its sources, decided by
 *              keyboard as well as pointer through the review routes; what is
 *              accepted is handed to the map; a link waits for its new end; a
 *              reader reads and decides nothing; no axe violation
 *   the sheet  a relation's fields, saved against its version; a newer
 *              version is a conflict that offers to reload, never a retry
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { Toaster } from 'sonner';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1/maps/relationship',
    useSearchParams: () => new URLSearchParams(),
}));

import { RelationSheet } from '@/components/bible/RelationSheet';
import { PendingStructureList } from '@/components/canvas/PendingStructureList';
import type { RelationView } from '@/lib/bible/api-client';
import { getRelationFieldDef, relationFieldDefs } from '@/lib/bible/templates';
import type { AcceptedStructure } from '@/lib/canvas/structure-preview';
import type { PendingStructureResult, PendingStructureView } from '@/lib/enrichment/api-client';
import { API, KIND_LABELS, mockFetch, SLUG, BOOK } from '../helpers/bible-ui';

const history = getRelationFieldDef('CHARACTER', 'loves', 'history')!;
const common = { roundNumber: 1, status: 'PENDING' as const, flags: [], citedAnswerIds: ['a1'], decidedAt: null, sessionId: 's1' };
const ilse: PendingStructureView = { ...common, id: 'p-new', kind: 'NEW_ELEMENT', newKind: 'CHARACTER', name: 'Ilse', summary: 'A ferry keeper.', createdElementId: null, fields: [], slot: null };
const waiting: PendingStructureView = {
    ...common,
    id: 'p-link',
    kind: 'NEW_RELATION',
    type: 'loves',
    label: 'loves',
    from: { elementId: 'e1', proposalId: null, name: 'Wren', kind: 'CHARACTER', exists: true },
    to: { elementId: null, proposalId: 'p-new', name: 'Ilse', kind: 'CHARACTER', exists: false },
    note: null,
    fields: [{ field: history, value: 'They met on the ferry.' }],
    createdRelationId: null,
};
const answers = { a1: { answerId: 'a1', question: 'Who does Wren love?', questionKind: 'OPEN' as const, answer: 'Ilse, since the ferry.', status: 'ANSWERED' as const } };
const PENDING = `${API}/proposals/pending-structure`;
const REVIEW = `${API}/interviews/s1/proposals`;

function list(canEdit = true, onAccepted: (a: AcceptedStructure) => void = () => {}) {
    return render(
        <>
            <PendingStructureList workspaceSlug={SLUG} bookId={BOOK.id} canEdit={canEdit} kindLabels={KIND_LABELS} drawnKinds={['CHARACTER', 'FACTION']} onAccepted={onAccepted} />
            <Toaster />
        </>,
    );
}

describe('the list beside the map', () => {
    it('lists every pending proposal with its sources; a link waits for its new end; no axe violation', async () => {
        mockFetch({ [`GET ${PENDING}`]: { json: { proposals: [ilse, waiting], answers, truncated: false } satisfies PendingStructureResult } });
        const { container } = list();
        const entry = await screen.findByTestId('structure-new-element');
        expect(entry).toHaveTextContent('Ilse');
        expect(entry).toHaveTextContent('Ilse, since the ferry.');
        const link = screen.getByTestId('new-relation-proposal');
        expect(within(link).getByTestId('relation-waits')).toBeInTheDocument();
        expect(within(link).getByRole('button', { name: 'Accept the relation Wren loves Ilse' })).toBeDisabled();
        expect(await axe(container)).toHaveNoViolations();
    });

    it('accepting by keyboard hands the new element to the map and reads the list again', async () => {
        const after = { ...waiting, to: { ...waiting.to, elementId: 'e9', exists: true } } as PendingStructureView;
        let reads = 0;
        const requests: Array<{ method: string; url: string; body: unknown }> = [];
        // The first read lists both; the next, after the acceptance, only the link (its end now exists).
        global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            requests.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
            const json =
                method === 'GET'
                    ? { proposals: reads++ === 0 ? [ilse, waiting] : [after], answers, truncated: false }
                    : { decision: { proposalId: 'p-new', status: 'ACCEPTED', elementId: 'e9', versionNumber: 1 } };
            return { ok: true, status: 200, json: async () => json } as Response;
        }) as unknown as typeof fetch;
        const accepted: AcceptedStructure[] = [];
        list(true, (a) => accepted.push(a));
        const button = await screen.findByRole('button', { name: 'Accept the new entry Ilse' });
        // A native button: focusable, and Enter activates it.
        button.focus();
        expect(button).toHaveFocus();
        fireEvent.click(button);
        await waitFor(() => expect(accepted).toEqual([{ kind: 'NEW_ELEMENT', elementId: 'e9', name: 'Ilse', elementKind: 'CHARACTER', filledFieldCount: 0 }]));
        await waitFor(() => expect(screen.queryByTestId('structure-new-element')).toBeNull());
        expect(screen.getByRole('button', { name: 'Accept the relation Wren loves Ilse' })).toBeEnabled();
        expect(requests.filter((r) => r.method === 'POST').map((r) => r.url)).toEqual([`${REVIEW}/p-new/accept`]);
    });

    it('draws an accepted link between the ends the SERVER names, not its own copy of them (#53 item 3)', async () => {
        // The list's copy of the new end (Ilse, accepted elsewhere a moment ago) knows it exists but not yet its id:
        // the edge is drawn from the decision, which names both ends, rather than waiting for the next reload.
        const raced = { ...waiting, to: { ...waiting.to, exists: true } } as PendingStructureView;
        global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            const json =
                method === 'GET'
                    ? { proposals: [raced], answers, truncated: false }
                    : { decision: { proposalId: 'p-link', status: 'ACCEPTED', elementId: null, relationId: 'r9', versionNumber: 1, relationEnds: { fromElementId: 'e1', toElementId: 'e9' } } };
            return { ok: true, status: 200, json: async () => json } as Response;
        }) as unknown as typeof fetch;
        const accepted: AcceptedStructure[] = [];
        list(true, (a) => accepted.push(a));
        fireEvent.click(await screen.findByRole('button', { name: 'Accept the relation Wren loves Ilse' }));
        await waitFor(() => expect(accepted).toEqual([{ kind: 'NEW_RELATION', relationId: 'r9', sourceElementId: 'e1', targetElementId: 'e9', label: 'loves' }]));
    });

    it('a beat whose slot CHANGED says so and offers the two choices instead of Accept: a place in its act, or none (D25)', async () => {
        const beat: PendingStructureView = {
            ...common,
            id: 'p-beat',
            kind: 'NEW_ELEMENT',
            newKind: 'PLOT_BEAT',
            name: 'The signs come down',
            summary: null,
            createdElementId: null,
            fields: [],
            slot: {
                afterElementId: 'b1',
                afterName: 'The bridge gives way',
                beforeElementId: 'b2',
                beforeName: null,
                act: 'opening',
                changed: 'NEIGHBOUR_GONE',
                choices: [
                    { elementId: 'b1', name: 'The bridge gives way' },
                    { elementId: 'b3', name: 'The town turns' },
                ],
                choicesTruncated: false,
            },
        };
        const { requests } = mockFetch({
            [`GET ${PENDING}`]: { json: { proposals: [beat], answers, truncated: false } },
            [`POST ${REVIEW}/p-beat/accept`]: { json: { decision: { proposalId: 'p-beat', status: 'ACCEPTED', elementId: 'e7', versionNumber: 2, placed: true } } },
        });
        const { container } = render(
            <>
                <PendingStructureList workspaceSlug={SLUG} bookId={BOOK.id} canEdit kindLabels={KIND_LABELS} drawnKinds={['PLOT_BEAT']} />
                <Toaster />
            </>,
        );
        const changed = await screen.findByTestId('slot-changed');
        expect(changed).toHaveTextContent('has been deleted');
        // The plain Accept would be refused (409 SLOT_CHANGED): it is not offered.
        expect(screen.queryByRole('button', { name: 'Accept the new entry The signs come down' })).toBeNull();
        expect(within(changed).getAllByRole('radio')).toHaveLength(3);
        fireEvent.click(within(changed).getByRole('radio', { name: 'After “The bridge gives way”' }));
        fireEvent.click(within(changed).getByRole('button', { name: 'Accept here' }));
        await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true));
        expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ placement: { after: 'b1', before: 'b3' } });
        expect(await axe(container)).toHaveNoViolations();
    });

    it('“Accept without a place” accepts the changed slot’s beat unplaced', async () => {
        const beat = {
            ...common,
            id: 'p-beat',
            kind: 'NEW_ELEMENT',
            newKind: 'PLOT_BEAT',
            name: 'The signs come down',
            summary: null,
            createdElementId: null,
            fields: [],
            slot: { afterElementId: 'b1', afterName: 'One', beforeElementId: 'b2', beforeName: 'Two', act: 'opening', changed: 'GAP_FILLED', choices: [], choicesTruncated: false },
        } satisfies PendingStructureView;
        const { requests } = mockFetch({
            [`GET ${PENDING}`]: { json: { proposals: [beat], answers, truncated: false } },
            [`POST ${REVIEW}/p-beat/accept`]: { json: { decision: { proposalId: 'p-beat', status: 'ACCEPTED', elementId: 'e7', versionNumber: 1, placed: false } } },
        });
        render(
            <>
                <PendingStructureList workspaceSlug={SLUG} bookId={BOOK.id} canEdit kindLabels={KIND_LABELS} drawnKinds={['PLOT_BEAT']} />
                <Toaster />
            </>,
        );
        expect(await screen.findByTestId('slot-changed')).toHaveTextContent('another beat now stands between “One” and “Two”');
        fireEvent.click(screen.getByRole('button', { name: 'Accept without a place' }));
        await waitFor(() => expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ placement: { unplaced: true } }));
        expect(await screen.findByText('Accepted. The signs come down is now in the bible, not placed in the story order yet.')).toBeInTheDocument();
    });

    it('a reader reads every proposal and decides nothing', async () => {
        mockFetch({ [`GET ${PENDING}`]: { json: { proposals: [ilse, waiting], answers, truncated: false } } });
        list(false);
        expect(await screen.findByTestId('structure-new-element')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Accept/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Reject/ })).toBeNull();
    });

    it('shows nothing when nothing waits', async () => {
        mockFetch({ [`GET ${PENDING}`]: { json: { proposals: [], answers: {}, truncated: false } } });
        list();
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        expect(screen.queryByTestId('structure-list')).toBeNull();
    });
});

describe('a relation opened in its sheet', () => {
    const relation = (version: number, value: string | null): RelationView => ({
        id: 'r1',
        type: 'loves',
        label: 'loves',
        inverseLabel: 'loved by',
        symmetric: false,
        from: { id: 'e1', name: 'Wren', kind: 'CHARACTER' },
        to: { id: 'e2', name: 'Tomas', kind: 'CHARACTER' },
        note: null,
        fields: relationFieldDefs('CHARACTER', 'loves').map((f) => ({ field: f, value: f.key === 'history' ? value : null })),
        versionNumber: version,
        versions: [],
    });
    const URL_ = `${API}/relations/r1`;

    it('saves its fields against the relation’s version', async () => {
        const { requests } = mockFetch({ [`GET ${URL_}`]: { json: { relation: relation(1, null) } }, [`PUT ${URL_}/fields`]: { json: { relation: relation(2, 'They met on the ferry.') } } });
        render(<RelationSheet open onOpenChange={() => {}} workspaceSlug={SLUG} bookId={BOOK.id} relationId="r1" title="loves Tomas" canEdit />);
        const sheet = await screen.findByTestId('relation-sheet');
        fireEvent.change(within(sheet).getAllByRole('textbox')[0], { target: { value: 'They met on the ferry.' } });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(screen.getByTestId('relation-sheet')).toHaveAttribute('data-version', '2'));
        expect(requests.find((r) => r.method === 'PUT')!.body).toEqual({ baseVersion: 1, fields: [{ key: 'history', value: 'They met on the ferry.' }] });
    });

    it('a newer version is a conflict: nothing retried, reload offered', async () => {
        const { requests } = mockFetch({
            [`GET ${URL_}`]: { json: { relation: relation(1, null) } },
            [`PUT ${URL_}/fields`]: { status: 409, json: { error: { code: 'CONFLICT', message: 'x', details: { reason: 'VERSION_CONFLICT' } } } },
        });
        render(<RelationSheet open onOpenChange={() => {}} workspaceSlug={SLUG} bookId={BOOK.id} relationId="r1" title="loves Tomas" canEdit />);
        const sheet = await screen.findByTestId('relation-sheet');
        fireEvent.change(within(sheet).getAllByRole('textbox')[0], { target: { value: 'Mine.' } });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
        expect(await within(sheet).findByRole('alert')).toHaveTextContent('Someone else saved');
        expect(within(sheet).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
        expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    });
});
