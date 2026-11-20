/**
 * The interview page (Phase 2.4): a round streams in — the planned fields,
 * then read-only drafts, then the committed questions that replace them —
 * and can be cancelled; the side panel fills as answers arrive (pending
 * enrichment, nothing written to the bible); finishing a round goes straight
 * on to the next; stopping keeps every answer and says so; a paused session
 * shows its reason and resumes; a session that asked nothing is "not
 * assessed"; a reader gets no control.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { Toaster } from 'sonner';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1/interviews/new',
    useSearchParams: () => new URLSearchParams(),
}));

import { InterviewSession, type InterviewSessionProps } from '@/components/interview/InterviewSession';
import { applyInterviewEvent, IDLE_STREAM } from '@/components/interview/use-interview-stream';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { KIND_LABELS, mockFetch } from '../helpers/bible-ui';
import { answered, BOOK, controlledStream, ELEMENTS, IAPI, interview, question, SLUG, streamOf } from '../helpers/interview-ui';

const FIELD_LABELS = { CHARACTER: { want: 'Want', need: 'Need', wound: 'Wound' } };

function mount(initial: InterviewSessionProps['initial'], over: Partial<InterviewSessionProps> = {}) {
    return render(
        <KeyboardShortcutProvider>
            <InterviewSession
                workspaceSlug={SLUG}
                book={BOOK}
                canEdit
                elements={ELEMENTS}
                fieldLabels={FIELD_LABELS}
                kindLabels={KIND_LABELS}
                initial={initial}
                {...over}
            />
            <Toaster />
        </KeyboardShortcutProvider>,
    );
}

const START = { kind: 'start' as const, target: { scope: 'ELEMENT' as const, elementId: 'el_1' }, setup: { depth: 2, detail: 3, personaKeys: [], offerRecommended: true, preferChoice: false } };

describe('a round streams in', () => {
    it('shows the planned fields, then drafts that cannot be answered, then the committed questions in their place', async () => {
        const stream = controlledStream();
        const { requests } = mockFetch({ [`POST ${IAPI}/stream`]: async () => stream.response as never });
        // mockFetch wraps answers; route the stream through the raw fetch instead.
        global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            requests.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
            return stream.response as unknown as Response;
        }) as unknown as typeof fetch;
        const replaceState = jest.spyOn(window.history, 'replaceState');
        mount(START);
        await waitFor(() => expect(requests[0]).toMatchObject({ method: 'POST', url: `${IAPI}/stream`, body: { scope: 'ELEMENT', elementId: 'el_1', depth: 2, detail: 3, personaKeys: [], offerRecommended: true, preferChoice: false } }));
        expect(screen.getByTestId('session-progress')).toHaveTextContent('Not assessed');

        await act(async () => stream.push({ type: 'started', sessionId: 'sess_1' }));
        expect(replaceState).toHaveBeenCalledWith(null, '', `/w/${SLUG}/books/${BOOK.id}/interviews/sess_1`);
        await act(async () => stream.push({ type: 'planned', roundNumber: 1, targets: [{ elementId: 'el_1', fieldKey: 'want' }, { elementId: 'el_1', fieldKey: 'need' }] }));
        const panel = screen.getByTestId('round-fields');
        expect(within(panel).getAllByTestId('round-field').map((r) => r.getAttribute('data-state'))).toEqual(['waiting', 'waiting']);
        expect(within(panel).getByText('Need')).toBeInTheDocument();
        expect(screen.getByTestId('stream-progress')).toHaveTextContent('Choosing what to ask next');

        await act(async () => stream.push({ type: 'thinking', call: 1, calls: 1 }));
        expect(screen.getByTestId('stream-progress')).toHaveTextContent('Wording the questions');
        await act(async () =>
            stream.push({ type: 'draft', draftId: 'draft-1', question: { elementId: 'el_1', targetsFieldKeys: ['want'], mode: 'FRONTIER', kind: 'OPEN', text: 'What does Aurel want?', options: null, scaleLabels: null, personaKey: null, reviewRequired: false } }),
        );
        const draft = screen.getByTestId('draft-card');
        expect(draft).toHaveTextContent('What does Aurel want?');
        expect(within(draft).queryByRole('textbox')).toBeNull();
        expect(within(draft).queryByRole('button')).toBeNull();
        expect(screen.queryByTestId('question-card')).toBeNull();

        const q1 = question({ text: 'What does Aurel want?' });
        const q2 = question({ kind: 'CHOICE', targetsFieldKeys: ['need'], text: 'What does Aurel need?' });
        await act(async () => {
            stream.push({ type: 'checking' });
            stream.push({ type: 'committed', interview: interview({ questions: [q1, q2] }) });
            stream.push({ type: 'done' });
            stream.end();
        });
        await waitFor(() => expect(screen.getAllByTestId('question-card')).toHaveLength(2));
        expect(screen.queryByTestId('draft-card')).toBeNull();
        expect(screen.queryByTestId('stream-progress')).toBeNull();
        expect(screen.getByRole('textbox', { name: 'Your answer' })).toBeInTheDocument();
    });

    it('cancelling stops the stream, says nothing was asked, and reads the session as stored', async () => {
        const stream = controlledStream();
        const calls: string[] = [];
        global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
            if (String(url).endsWith('/stream')) return stream.response as unknown as Response;
            return { ok: true, status: 200, json: async () => ({ interview: interview({ roundStatus: null }) }) } as unknown as Response;
        }) as unknown as typeof fetch;
        mount(START);
        await act(async () => stream.push({ type: 'started', sessionId: 'sess_1' }));
        await act(async () => stream.push({ type: 'thinking', call: 1, calls: 1 }));
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await act(async () => stream.end());
        expect(await screen.findByTestId('stream-cancelled')).toHaveTextContent('Nothing from that round was asked');
        await waitFor(() => expect(calls).toContain(`GET ${IAPI}/sess_1`));
        expect(await screen.findByRole('button', { name: 'Next round' })).toBeInTheDocument();
    });

    it('words a refusal before the stream from its reason (503 AI_UNAVAILABLE)', async () => {
        mockFetch({ [`POST ${IAPI}/stream`]: { status: 503, json: { error: { code: 'AI_UNAVAILABLE', message: 'x', details: { reason: 'CREDENTIAL_NOT_CONFIGURED' } } } } });
        mount(START);
        expect(await screen.findByTestId('stream-error')).toHaveTextContent('AI questions are not available on this server right now.');
        expect(screen.getByRole('link', { name: 'Back to the book' })).toBeInTheDocument();
    });

    it('names the packs a 503 PACKS_NOT_MOUNTABLE lists, by persona and by kind, and leaves out a name it does not know', async () => {
        const packs = [
            { name: 'craft-character', reason: 'STRUCTURAL_RECORD_REFUSED' },
            { name: 'persona-socratic', reason: 'STRUCTURAL_RECORD_REFUSED' },
            { name: 'persona-nobody', reason: 'UNKNOWN_PACK' },
        ];
        mockFetch({ [`POST ${IAPI}/stream`]: { status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'x', details: { reason: 'PACKS_NOT_MOUNTABLE', packs } } } } });
        mount(START);
        expect(await screen.findByTestId('stream-error')).toHaveTextContent(
            `These question packs are not ready on this server, so the interview cannot go on: ${KIND_LABELS.CHARACTER} questions, the Socratic interviewer.`,
        );
    });

    it('says the packs are not ready, unnamed, when the refusal lists none it knows', async () => {
        mockFetch({ [`POST ${IAPI}/stream`]: { status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'x', details: { reason: 'PACKS_NOT_MOUNTABLE', packs: [{ name: 'x', reason: 'NO_RECORD' }] } } } } });
        mount(START);
        expect(await screen.findByTestId('stream-error')).toHaveTextContent('The question packs are not ready on this server yet, so an interview cannot start.');
    });
});

it('a session paused PACK_CHANGED says why, and a session from before pinning says to start another', () => {
    const { unmount } = mount({ kind: 'existing', interview: interview({ status: 'PAUSED', stopReason: 'PACK_CHANGED', roundStatus: 'CLOSED' }) });
    expect(screen.getByTestId('stop-reason')).toHaveTextContent('A question pack this interview was started with has changed since.');
    unmount();
    const unpinned = interview({ status: 'PAUSED', stopReason: 'PACK_CHANGED', roundStatus: 'CLOSED' });
    unpinned.session.stopDetail = { problem: 'PACK_NOT_PINNED', packs: ['craft-character'] };
    mount({ kind: 'existing', interview: unpinned });
    expect(screen.getByTestId('stop-reason')).toHaveTextContent('This interview was started before question packs were recorded with it, so it cannot go on.');
});

it('the side panel fills as answers arrive: pending enrichment, the answer read-only', async () => {
    const q = question();
    mockFetch({ [`POST ${IAPI}/sess_1/questions/${q.id}/answer`]: { status: 201, json: { question: answered(q, { text: 'To be forgiven.' }) } } });
    mount({ kind: 'existing', interview: interview({ questions: [q] }) });
    const panel = screen.getByTestId('round-fields');
    expect(within(panel).getByTestId('round-field')).toHaveAttribute('data-state', 'waiting');
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: 'To be forgiven.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(within(panel).getByTestId('round-field')).toHaveAttribute('data-state', 'pending'));
    expect(within(panel).getByText('Pending enrichment')).toBeInTheDocument();
    expect(within(panel).getByText('To be forgiven.')).toBeInTheDocument();
    expect(screen.getByTestId('session-progress')).toHaveTextContent('1 of 1 answered');
});

it('a session that asked nothing reads "not assessed", never a percentage (rule 6)', () => {
    mockFetch({});
    mount({ kind: 'existing', interview: interview({ roundStatus: null }) });
    expect(screen.getByTestId('session-progress')).toHaveTextContent('Not assessed: no question asked yet');
});

it('finishing a round closes it (skipping what is left) and goes straight on to the next', async () => {
    const q = question();
    const calls: Array<{ url: string; body: unknown }> = [];
    const next = question({ text: 'What does Aurel fear?' });
    global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (String(url).endsWith('/rounds/1/close')) return { ok: true, status: 200, json: async () => ({ interview: interview({ questions: [q], roundStatus: 'CLOSED' }) }) } as unknown as Response;
        return streamOf([{ type: 'planned', roundNumber: 2, targets: [] }, { type: 'committed', interview: interview({ questions: [next], number: 2 }) }, { type: 'done' }]) as unknown as Response;
    }) as unknown as typeof fetch;
    mount({ kind: 'existing', interview: interview({ questions: [q] }) });
    expect(screen.getByText('Questions without an answer: 1.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip the rest and finish' }));
    expect(await screen.findByText('What does Aurel fear?')).toBeInTheDocument();
    expect(calls.map((c) => c.url)).toEqual([`${IAPI}/sess_1/rounds/1/close`, `${IAPI}/sess_1/rounds/stream`]);
    expect(calls[0].body).toEqual({ skipUnanswered: true });
});

it('stopping keeps every answer and says why it stopped; a paused session resumes from Continue', async () => {
    const q = answered(question(), { text: 'Yes.' });
    mockFetch({ [`POST ${IAPI}/sess_1/stop`]: { json: { interview: interview({ questions: [q], status: 'STOPPED', stopReason: 'AUTHOR_STOPPED', roundStatus: 'CLOSED' }) } } });
    const { unmount } = mount({ kind: 'existing', interview: interview({ questions: [q] }) });
    fireEvent.click(screen.getByRole('button', { name: 'Stop interview' }));
    await waitFor(() => expect(document.getElementById('interview-stop-confirm')).not.toBeNull());
    fireEvent.click(document.getElementById('interview-stop-confirm')!);
    expect(await screen.findByTestId('stop-reason')).toHaveTextContent('You stopped this interview. Every answer you gave is kept.');
    expect(screen.getAllByText('Yes.').length).toBeGreaterThan(0);
    unmount();

    const calls: string[] = [];
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
        calls.push(String(url));
        return streamOf([{ type: 'committed', interview: interview({ questions: [question()], number: 2 }) }, { type: 'done' }]) as unknown as Response;
    }) as unknown as typeof fetch;
    mount({ kind: 'existing', interview: interview({ status: 'PAUSED', stopReason: 'KILL_SWITCH', roundStatus: 'CLOSED' }) });
    expect(screen.getByTestId('stop-reason')).toHaveTextContent('AI questions are switched off for now.');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getAllByTestId('question-card')).toHaveLength(1));
    expect(calls).toEqual([`${IAPI}/sess_1/rounds/stream`]);
});

it('a reader sees the interview as text: no answer control, no stop, no next round', async () => {
    mockFetch({});
    const { container } = mount({ kind: 'existing', interview: interview({ questions: [answered(question({ kind: 'CHOICE' }), { choice: 'To stay' })] }) }, { canEdit: false });
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop interview' })).toBeNull();
    expect(screen.queryByTestId('round-controls')).toBeNull();
    expect(screen.getByText('You can read this interview; only an editor can answer.')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
});

it('has no axe violations with a round open', async () => {
    mockFetch({});
    const { container } = mount({ kind: 'existing', interview: interview({ questions: [question({ kind: 'SCALE' }), question({ kind: 'OPEN' })] }) });
    expect(await axe(container)).toHaveNoViolations();
});

describe('the stream reducer (lifted from use-assistant-stream)', () => {
    it('replaces every draft with the committed round, and ignores an event it does not know', () => {
        let s = applyInterviewEvent(IDLE_STREAM, { type: 'draft', draftId: 'd1', question: { elementId: 'e', targetsFieldKeys: ['want'], mode: 'FRONTIER', kind: 'OPEN', text: 'x?', options: null, scaleLabels: null, personaKey: null, reviewRequired: false } });
        expect(s.drafts).toHaveLength(1);
        s = applyInterviewEvent(s, { type: 'committed', interview: interview() });
        expect(s.drafts).toEqual([]);
        expect(s.committed).not.toBeNull();
        expect(applyInterviewEvent(s, { type: 'novel' } as never)).toBe(s);
        expect(applyInterviewEvent(s, { type: 'refusal', reason: 'INTERVIEW_ENDED' })).toMatchObject({ refusal: 'INTERVIEW_ENDED' });
        expect(applyInterviewEvent(s, { type: 'done' })).toMatchObject({ phase: 'done' });
    });
});
