/**
 * Export and import on a book's home (Phase 1.3): the two export downloads
 * for every viewer, Import only for one the server says may edit; the import
 * modal sends a bundle as the request body and shows the API's report (what
 * was created, updated, left unchanged), or every problem of a refused
 * bundle, by file, worded from its reason; a concept note is sent as text.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';

const refresh = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh, replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1',
    useSearchParams: () => new URLSearchParams(),
}));

import { BookBoard } from '@/components/bible/BookBoard';
import type { BookView, BundleImportReport, ConceptNoteReport } from '@/lib/bible/api-client';
import { kindSummaries } from '@/lib/bible/ui-model';
import { API, mockFetch, SLUG } from '../helpers/bible-ui';

const BOOK: BookView = {
    id: 'book_1',
    title: 'The Salt Roads',
    logline: null,
    genre: null,
    audience: null,
    targetLength: null,
    stage: 'PLANNING',
    createdAt: '2026-11-19T10:00:00.000Z',
    updatedAt: '2026-11-19T10:00:00.000Z',
};

const REPORT: BundleImportReport = {
    elements: { created: 2, updated: 1, unchanged: 1 },
    versionsWritten: 3,
    relations: { created: 1, updated: 0, unchanged: 2 },
    bookDetailsApplied: false,
    items: [
        { id: 'e1', kind: 'CHARACTER', slug: 'mara', name: 'Mara Vell', outcome: 'created', versionNumber: 1 },
        { id: 'e2', kind: 'CHARACTER', slug: 'tam', name: 'Tam Vell', outcome: 'created', versionNumber: 1 },
        { id: 'e3', kind: 'FACTION', slug: 'guild', name: 'The Salt Guild', outcome: 'updated', versionNumber: 4 },
        { id: 'e4', kind: 'THEME', slug: 'debt', name: 'Debt', outcome: 'unchanged', versionNumber: null },
    ],
};

beforeEach(() => refresh.mockClear());

function board(canEdit = true) {
    return render(<BookBoard workspaceSlug={SLUG} book={BOOK} kinds={kindSummaries()} elements={[]} canEdit={canEdit} />);
}

function openImport() {
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    return screen.getByRole('dialog');
}

function chooseBundle(dialog: HTMLElement, name = 'salt-roads-bible.zip') {
    const file = new File([new Uint8Array([0x50, 0x4b, 0x05, 0x06])], name, { type: 'application/zip' });
    fireEvent.change(within(dialog).getByLabelText(/Bundle \(\.zip\)/), { target: { files: [file] } });
    return file;
}

describe('export', () => {
    it('offers both downloads to a reader, and no import', () => {
        board(false);
        expect(screen.getByRole('link', { name: 'Export Markdown' })).toHaveAttribute('href', `${API}/export/bundle`);
        expect(screen.getByRole('link', { name: 'Export PDF' })).toHaveAttribute('href', `${API}/export/pdf`);
        expect(screen.getByRole('link', { name: 'Export PDF' })).toHaveAttribute('download');
        expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    });
});

describe('importing a bundle', () => {
    it('sends the zip as the body and shows the report, then refreshes the page behind it', async () => {
        const { fn } = mockFetch({ [`POST ${API}/import/bundle`]: { json: { report: REPORT } } });
        board();
        const dialog = openImport();
        const file = chooseBundle(dialog);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));

        const report = await within(dialog).findByTestId('import-report');
        const [url, init] = fn.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${API}/import/bundle`);
        expect(init.method).toBe('POST');
        expect(init.body).toBe(file);
        expect(init.headers).toEqual({ 'content-type': 'application/zip' });

        expect(report).toHaveTextContent('2 created, 1 updated, 1 unchanged');
        expect(report).toHaveTextContent('3 versions written');
        expect(report).toHaveTextContent('Relations: 1 added, 0 updated, 2 unchanged');
        const rows = within(report).getAllByRole('listitem');
        expect(rows.map((r) => r.textContent)).toEqual(['Mara VellCreated', 'Tam VellCreated', 'The Salt GuildUpdated', 'DebtUnchanged']);
        expect(within(report).getByRole('link', { name: 'The Salt Guild' })).toHaveAttribute('href', '/w/ada/books/book_1/elements/e3');
        expect(refresh).toHaveBeenCalled();
        expect(within(dialog).getByRole('button', { name: 'Done' })).toBeInTheDocument();
        expect(await axe(dialog)).toHaveNoViolations();
    });

    it('asks the API to apply the book’s details only when the author ticks the box', async () => {
        const { fn } = mockFetch({ [`POST ${API}/import/bundle?bookDetails=apply`]: { json: { report: { ...REPORT, bookDetailsApplied: true } } } });
        board();
        const dialog = openImport();
        chooseBundle(dialog);
        fireEvent.click(within(dialog).getByRole('checkbox', { name: /Also replace this book's title/ }));
        fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
        expect(await within(dialog).findByText('The book\'s title and details were updated.')).toBeInTheDocument();
        expect(fn.mock.calls[0][0]).toBe(`${API}/import/bundle?bookDetails=apply`);
    });

    it('shows every problem of a refused bundle, by file, worded from its reason, and keeps the form', async () => {
        mockFetch({
            [`POST ${API}/import/bundle`]: {
                status: 400,
                json: {
                    error: {
                        code: 'VALIDATION_ERROR',
                        message: 'server words the UI never shows',
                        details: {
                            reason: 'BUNDLE_REFUSED',
                            problems: [
                                { path: 'character/mara.md', reason: 'NOT_AN_OPTION', key: 'fields.prominence' },
                                { path: 'villain/x.md', reason: 'UNEXPECTED_ENTRY' },
                                { path: '', reason: 'SOME_NEW_REASON' },
                            ],
                            truncated: true,
                        },
                    },
                },
            },
        });
        board();
        const dialog = openImport();
        chooseBundle(dialog);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
        const refusal = await within(dialog).findByTestId('import-refusal');
        expect(refusal).toHaveTextContent('The bundle was refused; nothing was imported.');
        const items = within(refusal).getAllByRole('listitem').map((li) => li.textContent);
        expect(items).toEqual([
            "character/mara.md(fields.prominence)This value is not one of the field's choices.",
            'villain/x.mdThis file is not part of a bundle.',
            'The archiveThe import was refused (SOME_NEW_REASON).',
        ]);
        expect(refusal).toHaveTextContent('More problems were found than are listed here.');
        expect(refusal).not.toHaveTextContent('server words');
        expect(refresh).not.toHaveBeenCalled();
        expect(within(dialog).getByRole('button', { name: 'Import' })).toBeInTheDocument();
    });

    it('words a refusal of the upload itself', async () => {
        mockFetch({ [`POST ${API}/import/bundle`]: { status: 400, json: { error: { code: 'VALIDATION_ERROR', message: 'x', details: { reason: 'UPLOAD_INFECTED' } } } } });
        board();
        const dialog = openImport();
        chooseBundle(dialog);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
        expect(await within(dialog).findByText('The virus scan refused this file.')).toBeInTheDocument();
    });

    it('asks for a file before sending anything', () => {
        const { fn } = mockFetch({});
        board();
        const dialog = openImport();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
        expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose a bundle to import.');
        expect(fn).not.toHaveBeenCalled();
    });
});

describe('importing a concept note', () => {
    it('sends the pasted text and name, and links to the research note it made', async () => {
        const note: ConceptNoteReport = { element: { id: 'r1', kind: 'RESEARCH', slug: 'pitch', name: 'Pitch' }, outcome: 'created', versionNumber: 1 };
        const { requests } = mockFetch({ [`POST ${API}/import/concept-note`]: { status: 201, json: { report: note } } });
        board();
        const dialog = openImport();
        fireEvent.click(within(dialog).getByText('Concept note'));
        fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Pitch' } });
        fireEvent.change(within(dialog).getByLabelText(/^Note/), { target: { value: 'A ferrywoman crosses a drowned country.' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
        const report = await within(dialog).findByTestId('import-report');
        expect(requests[0]).toEqual({ method: 'POST', url: `${API}/import/concept-note`, body: { text: 'A ferrywoman crosses a drowned country.', name: 'Pitch' } });
        expect(report).toHaveTextContent('Created the research note “Pitch”.');
        expect(within(report).getByRole('link', { name: 'Open the entry' })).toHaveAttribute('href', '/w/ada/books/book_1/elements/r1');
        await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it('asks for text before sending anything', () => {
        const { fn } = mockFetch({});
        board();
        const dialog = openImport();
        fireEvent.click(within(dialog).getByText('Concept note'));
        fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
        expect(within(dialog).getByRole('alert')).toHaveTextContent('Paste a note or choose a file.');
        expect(fn).not.toHaveBeenCalled();
    });
});
