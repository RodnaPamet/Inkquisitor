/**
 * Phase 5.H-a in the product:
 *   - D3 RE-VERIFIED IN WORDS (roadmap 5.H item 5): Settings → "How Inkquisitor uses AI" says that no model writes or
 *     rewrites the manuscript, and the manuscript's outline says it again in a line; the wording is the catalogue's
 *     (`aiUse`), so a change to it is a change to the product's promise, read here;
 *   - "Your data" (D36): the export's passphrase is judged by the server's own rule before it is sent, and goes in the
 *     POST body only; the deletion is disabled until the workspace's name is typed exactly;
 *   - Recently deleted scenes (issue #71): listed, restored, and the manuscript points at them.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { AiUseStatement } from '@/components/settings/AiUseStatement';
import { YourDataPanel } from '@/components/settings/YourDataPanel';
import { ManuscriptPage } from '@/components/manuscript/ManuscriptPage';
import { DeletedScenesList } from '@/components/manuscript/DeletedScenesList';
import messages from '../../messages/en.json';
import { mockFetch, SLUG } from '../helpers/bible-ui';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }), usePathname: () => '/', useSearchParams: () => new URLSearchParams() }));

describe('D3 in the product: "How Inkquisitor uses AI"', () => {
    it('renders the statement that no model writes or rewrites the manuscript, with its points', async () => {
        const { container } = render(<AiUseStatement />);
        const section = screen.getByTestId('ai-use-statement');
        expect(within(section).getByRole('heading', { name: 'How Inkquisitor uses AI' })).toBeInTheDocument();
        expect(screen.getByTestId('ai-use-d3')).toHaveTextContent('No AI model writes or rewrites your manuscript. Every word of your scenes is yours.');
        expect(within(section).getAllByRole('listitem')).toHaveLength(4);
        expect(section).toHaveTextContent('never in its text');
        expect(await axe(container)).toHaveNoViolations();
    });

    it('the catalogue’s statement says it plainly (a softened promise fails here)', () => {
        expect(messages.aiUse.statement).toMatch(/^No AI model writes or rewrites your manuscript\./);
        expect(messages.aiUse.editorLine).toMatch(/^No AI writes or rewrites your manuscript/);
    });

    it('the manuscript says it too, beside its outline', () => {
        mockFetch({});
        render(
            <ManuscriptPage
                workspaceSlug={SLUG}
                book={{ id: 'book_1', title: 'The Salt Roads' }}
                initial={{ manuscriptId: null, singleDefaultPart: false, parts: [], totals: { parts: 0, chapters: 0, scenes: 0, words: 0, recentlyDeleted: 0 } }}
                canEdit={false}
            />,
        );
        expect(screen.getByTestId('manuscript-d3-line')).toHaveTextContent('No AI writes or rewrites your manuscript: its words are yours.');
    });
});

describe('Your data (D36)', () => {
    it('is offered only to a viewer the server says may', () => {
        const { container } = render(<YourDataPanel workspaceSlug={SLUG} workspaceName="Ilse's" canExport={false} canDelete={false} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('judges the passphrase before sending it, and sends it in the body only', async () => {
        const requests: Array<{ url: string; method: string; body: unknown }> = [];
        const original = global.fetch;
        global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
            // jsdom has no Response: the download reads `ok`, a header and `blob()`.
            return { ok: true, status: 200, headers: { get: (h: string) => (h.toLowerCase() === 'content-disposition' ? 'attachment; filename="x.zip"' : null) }, blob: async () => new Blob([new Uint8Array([1, 2, 3])]) } as unknown as Response;
        }) as typeof fetch;
        URL.createObjectURL = jest.fn(() => 'blob:x');
        URL.revokeObjectURL = jest.fn();
        try {
            render(<YourDataPanel workspaceSlug={SLUG} workspaceName="Ilse's" canExport canDelete={false} />);
            fireEvent.click(screen.getByRole('button', { name: 'Export everything' }));
            const pass = await screen.findByLabelText('Passphrase');
            const again = screen.getByLabelText('Passphrase again');
            const submit = screen.getByRole('button', { name: 'Download archive' });
            fireEvent.change(pass, { target: { value: 'short' } });
            expect(screen.getByTestId('workspace-export-hint')).toHaveTextContent('The passphrase is too short.');
            expect(submit).toBeDisabled();
            fireEvent.change(pass, { target: { value: 'aaaaaaaaaaaaaaaa' } });
            expect(screen.getByTestId('workspace-export-hint')).toHaveTextContent('repeats too few characters');
            fireEvent.change(pass, { target: { value: 'salt roads at low tide' } });
            fireEvent.change(again, { target: { value: 'salt roads at low tid' } });
            expect(submit).toBeDisabled();
            fireEvent.change(again, { target: { value: 'salt roads at low tide' } });
            expect(submit).not.toBeDisabled();
            fireEvent.click(submit);
            await waitFor(() => expect(requests).toHaveLength(1));
            expect(requests[0]).toEqual({ url: `/api/w/${SLUG}/export`, method: 'POST', body: { passphrase: 'salt roads at low tide' } });
            expect(requests[0].url).not.toContain('salt');
        } finally {
            global.fetch = original;
        }
    });

    it('deletes the workspace only once its name is typed exactly', async () => {
        render(<YourDataPanel workspaceSlug={SLUG} workspaceName="Ilse's Books" canExport={false} canDelete />);
        fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }));
        const input = await screen.findByLabelText("Type Ilse's Books to confirm");
        const submit = screen.getAllByRole('button', { name: 'Delete workspace' }).at(-1)!;
        fireEvent.change(input, { target: { value: "ilse's books" } });
        expect(submit).toBeDisabled();
        fireEvent.change(input, { target: { value: "  Ilse's Books " } });
        expect(submit).not.toBeDisabled();
    });
});

describe('Recently deleted scenes (issue #71)', () => {
    const deleted = { id: 'sc_1', title: 'Low tide', wordCount: 812, chapterId: 'ch_1', chapterTitle: 'The Harbour', deletedAt: '2026-11-20T10:00:00.000Z', restorableUntil: '2026-12-20T10:00:00.000Z' };

    it('the outline points at Recently deleted when it holds any', () => {
        mockFetch({});
        render(
            <ManuscriptPage
                workspaceSlug={SLUG}
                book={{ id: 'book_1', title: 'The Salt Roads' }}
                initial={{ manuscriptId: 'm_1', singleDefaultPart: true, parts: [], totals: { parts: 1, chapters: 0, scenes: 0, words: 0, recentlyDeleted: 2 } }}
                canEdit
            />,
        );
        // (The catalogue mock does not render ICU plurals; the real catalogue says "2 scenes in Recently deleted".)
        expect(screen.getByRole('link', { name: /in Recently deleted$/ })).toHaveAttribute('href', `/w/${SLUG}/books/book_1/manuscript/deleted`);
    });

    it('lists each scene with its chapter and dates, and restores one', async () => {
        const { requests: calls } = mockFetch({ [`POST /api/w/${SLUG}/books/book_1/manuscript/deleted-scenes/sc_1/restore`]: { json: { id: 'sc_1', placement: 'END_OF_CHAPTER' } } });
        render(<DeletedScenesList workspaceSlug={SLUG} book={{ id: 'book_1', title: 'The Salt Roads' }} scenes={[deleted]} canEdit />);
        const table = screen.getByTestId('deleted-scenes-table');
        expect(table).toHaveTextContent('Low tide');
        expect(table).toHaveTextContent('The Harbour');
        fireEvent.click(screen.getByRole('button', { name: 'Restore Low tide' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    });

    it('a reader sees the list with no Restore', () => {
        render(<DeletedScenesList workspaceSlug={SLUG} book={{ id: 'book_1', title: 'The Salt Roads' }} scenes={[deleted]} canEdit={false} />);
        expect(screen.queryByRole('button', { name: 'Restore Low tide' })).toBeNull();
    });
});
