/**
 * One question card (Phase 2.4): the answer control of each kind; the
 * recommendation as one click; Skip, Decide later and "Ask me this
 * differently"; autosave per answer (one request per answer, never batched; a
 * failed save keeps the answer and retries); keyboard (digits pick within the
 * card and never while typing; Enter saves and moves on); the guard's marker;
 * and a reader's read-only view.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { QuestionCard, type QuestionCardProps } from '@/components/interview/QuestionCard';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { mockFetch } from '../helpers/bible-ui';
import { answered, IAPI, IDS, question } from '../helpers/interview-ui';

function mount(over: Partial<QuestionCardProps> & Pick<QuestionCardProps, 'question'>) {
    const props: QuestionCardProps = {
        ids: IDS,
        number: 1,
        about: 'Aurel Pask · Want',
        personaName: null,
        canEdit: true,
        answerable: true,
        onChanged: jest.fn(),
        onRephrased: jest.fn(),
        onAdvance: jest.fn(),
        ...over,
    };
    const utils = render(
        <KeyboardShortcutProvider>
            <QuestionCard {...props} />
        </KeyboardShortcutProvider>,
    );
    return { ...utils, props };
}

const answerUrl = (id: string) => `${IAPI}/sess_1/questions/${id}/answer`;

describe('each kind has its control', () => {
    it('OPEN: a text box, saved when the author saves it', async () => {
        const q = question({ kind: 'OPEN' });
        const { requests } = mockFetch({ [`POST ${answerUrl(q.id)}`]: { status: 201, json: { question: answered(q, { text: 'To be forgiven.' }) } } });
        const { props } = mount({ question: q });
        const box = screen.getByRole('textbox', { name: 'Your answer' });
        fireEvent.change(box, { target: { value: 'To be forgiven.' } });
        expect(requests).toHaveLength(0);
        fireEvent.click(screen.getByRole('button', { name: 'Save answer' }));
        await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
        expect(requests).toEqual([{ method: 'POST', url: answerUrl(q.id), body: { text: 'To be forgiven.' } }]);
        expect(screen.getByTestId('save-state')).toHaveTextContent('Saved');
    });

    it('SCENARIO: the scenario shown as a passage, then a text box', () => {
        mockFetch({});
        mount({ question: question({ kind: 'SCENARIO', text: 'The ferry fails mid-river: what does Aurel do?' }) });
        expect(screen.getByText('The ferry fails mid-river: what does Aurel do?').tagName).toBe('BLOCKQUOTE');
        expect(screen.getByRole('textbox', { name: 'Your answer' })).toBeInTheDocument();
    });

    it('CHOICE: its options, a pick saved at once', async () => {
        const q = question({ kind: 'CHOICE' });
        const { requests } = mockFetch({ [`POST ${answerUrl(q.id)}`]: { status: 201, json: { question: answered(q, { choice: 'To stay' }) } } });
        mount({ question: q });
        const group = screen.getByTestId('answer-options');
        expect(within(group).getAllByRole('radio')).toHaveLength(3);
        fireEvent.click(within(group).getByRole('radio', { name: '2. To stay' }));
        await waitFor(() => expect(requests).toHaveLength(1));
        expect(requests[0].body).toEqual({ choice: 'To stay' });
    });

    it('EITHER_OR: exactly its two options', () => {
        mockFetch({});
        mount({ question: question({ kind: 'EITHER_OR' }) });
        expect(within(screen.getByTestId('answer-options')).getAllByRole('radio')).toHaveLength(2);
    });

    it('SCALE: one to five with the meaning of each end', async () => {
        const q = question({ kind: 'SCALE' });
        const { requests } = mockFetch({ [`POST ${answerUrl(q.id)}`]: { status: 201, json: { question: answered(q, { scale: 4 }) } } });
        mount({ question: q });
        expect(within(screen.getByTestId('answer-options')).getAllByRole('radio')).toHaveLength(5);
        expect(screen.getByText('1 — faint')).toBeInTheDocument();
        expect(screen.getByText('5 — overwhelming')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('radio', { name: '4' }));
        await waitFor(() => expect(requests[0]?.body).toEqual({ scale: 4 }));
    });
});

it('takes the recommendation with one click', async () => {
    const q = question({ kind: 'CHOICE', recommendedAnswer: 'To stay' });
    const { requests } = mockFetch({ [`POST ${answerUrl(q.id)}`]: { status: 201, json: { question: answered(q, { choice: 'To stay', acceptedRecommendation: true }) } } });
    const { props } = mount({ question: q });
    expect(screen.getByTestId('recommendation')).toHaveTextContent('Suggested: To stay');
    fireEvent.click(screen.getByRole('button', { name: 'Use the suggestion' }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    expect(requests).toEqual([{ method: 'POST', url: answerUrl(q.id), body: { acceptRecommendation: true } }]);
    expect(screen.getByRole('radio', { name: '2. To stay' })).toBeChecked();
});

it.each([
    ['Skip', 'skip', 'SKIPPED'],
    ['Decide later', 'decide-later', 'DECIDE_LATER'],
] as const)('%s posts its own route', async (label, route, status) => {
    const q = question();
    const { requests } = mockFetch({ [`POST ${IAPI}/sess_1/questions/${q.id}/${route}`]: { status: 201, json: { question: { ...q, answer: { revision: 1, status, text: null, choice: null, scale: null, acceptedRecommendation: false } } } } });
    const { props } = mount({ question: q });
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledWith(expect.objectContaining({ answer: expect.objectContaining({ status }) })));
    expect(requests.map((r) => r.url)).toEqual([`${IAPI}/sess_1/questions/${q.id}/${route}`]);
});

it('"Ask me this differently" hands the replacement over, and words a refusal', async () => {
    const q = question();
    const replacement = question({ replacesQuestionId: q.id, text: 'Picture Aurel at the ferry: what is she reaching for?' });
    mockFetch({ [`POST ${IAPI}/sess_1/questions/${q.id}/rephrase`]: { status: 201, json: { question: replacement } } });
    const { props } = mount({ question: q });
    fireEvent.click(screen.getByRole('button', { name: 'Ask me this differently' }));
    await waitFor(() => expect(props.onRephrased).toHaveBeenCalledWith(replacement, q.id));

    const other = question();
    mockFetch({ [`POST ${IAPI}/sess_1/questions/${other.id}/rephrase`]: { status: 409, json: { error: { code: 'CONFLICT', message: 'x', details: { reason: 'NO_REPHRASE' } } } } });
    mount({ question: other });
    fireEvent.click(screen.getAllByRole('button', { name: 'Ask me this differently' })[1]);
    expect(await screen.findByRole('alert')).toHaveTextContent('No other way to ask this came back');
});

it('autosaves per answer: each pick is its own request, one at a time, the latest sent last', async () => {
    const q = question({ kind: 'CHOICE' });
    let release: () => void = () => {};
    const { requests } = mockFetch({
        [`POST ${answerUrl(q.id)}`]: async () => {
            await new Promise<void>((r) => (release = r));
            return { status: 201, json: { question: answered(q, { choice: 'To leave' }) } };
        },
    });
    mount({ question: q });
    fireEvent.click(screen.getByRole('radio', { name: '1. To leave' }));
    fireEvent.click(screen.getByRole('radio', { name: '3. To be forgiven' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => release());
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests.map((r) => r.body)).toEqual([{ choice: 'To leave' }, { choice: 'To be forgiven' }]);
    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveAttribute('data-state', 'saved'));
});

it('a failed save keeps the answer, says why, and sends it again on retry (the 20-revision cap included)', async () => {
    const q = question({ kind: 'OPEN' });
    const { requests } = mockFetch({
        [`POST ${answerUrl(q.id)}`]: { status: 409, json: { error: { code: 'CONFLICT', message: 'x', details: { reason: 'ANSWER_REVISIONS_EXHAUSTED' } } } },
    });
    mount({ question: q });
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: 'Mine, still.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(await screen.findByText(/answered as many times as it can be \(20\)/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Your answer' })).toHaveValue('Mine, still.');
    mockFetch({ [`POST ${answerUrl(q.id)}`]: { status: 201, json: { question: answered(q, { text: 'Mine, still.' }) } } });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent('Saved'));
    expect(requests).toHaveLength(1);
});

describe('keyboard first', () => {
    it('a digit picks its option while focus is in the card, Enter moves on', async () => {
        const q = question({ kind: 'CHOICE' });
        const { requests } = mockFetch({ [`POST ${answerUrl(q.id)}`]: { status: 201, json: { question: answered(q, { choice: 'To be forgiven' }) } } });
        const { props } = mount({ question: q });
        const card = screen.getByTestId('question-card');
        act(() => card.focus());
        fireEvent.keyDown(card, { key: '3' });
        await waitFor(() => expect(requests[0]?.body).toEqual({ choice: 'To be forgiven' }));
        fireEvent.keyDown(card, { key: 'Enter' });
        expect(props.onAdvance).toHaveBeenCalledTimes(1);
    });

    it('a digit typed into a text box is text, not a pick; Ctrl+Enter saves from the box', async () => {
        const q = question({ kind: 'SCALE' });
        const { requests } = mockFetch({ [`POST ${answerUrl(q.id)}`]: { status: 201, json: { question: answered(q, { scale: 2 }) } } });
        mount({ question: q });
        fireEvent.click(screen.getByRole('radio', { name: '2' }));
        await waitFor(() => expect(requests).toHaveLength(1));
        const reason = screen.getByRole('textbox', { name: 'Why (optional)' });
        act(() => reason.focus());
        fireEvent.keyDown(reason, { key: '5' });
        expect(requests).toHaveLength(1);
        fireEvent.change(reason, { target: { value: 'Only at night.' } });
        fireEvent.keyDown(reason, { key: 'Enter', ctrlKey: true });
        await waitFor(() => expect(requests).toHaveLength(2));
        expect(requests[1].body).toEqual({ scale: 2, text: 'Only at night.' });
    });

    it('a digit pressed outside the card does nothing', () => {
        const { requests } = mockFetch({});
        mount({ question: question({ kind: 'CHOICE' }) });
        fireEvent.keyDown(document.body, { key: '1' });
        expect(requests).toHaveLength(0);
    });
});

it('marks a question the guard flagged', () => {
    mockFetch({});
    mount({ question: question({ reviewRequired: true }) });
    expect(screen.getByTestId('review-required')).toHaveTextContent('Flagged for review');
});

it('a reader sees the question and the answer as text, and no control', async () => {
    mockFetch({});
    const q = answered(question({ kind: 'CHOICE', recommendedAnswer: 'To stay' }), { choice: 'To stay', text: 'She owes the river.' });
    const { container } = mount({ question: q, canEdit: false });
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('answer-readonly')).toHaveTextContent('To stay — She owes the river.');
    expect(await axe(container)).toHaveNoViolations();
});

it('has no axe violations for any kind', async () => {
    mockFetch({});
    for (const kind of ['OPEN', 'CHOICE', 'EITHER_OR', 'SCENARIO', 'SCALE'] as const) {
        const { container, unmount } = mount({ question: question({ kind, recommendedAnswer: kind === 'SCALE' ? 3 : null }) });
        expect(await axe(container)).toHaveNoViolations();
        unmount();
    }
});
