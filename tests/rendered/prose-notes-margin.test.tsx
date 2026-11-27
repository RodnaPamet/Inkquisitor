/**
 * The scene editor's margin (Phase 5.2, D34): a scene never checked never
 * reads "no notes" (rule 6); each note is a button announced with its rule and
 * its text; an open note says what was found and offers Dismiss, the rule off
 * for the book, and — for a deterministic suggestion — Accept and Reject; a
 * reader sees the notes and no action. Accessible (axe).
 *
 * (The next-intl mock interpolates `{param}` but runs no ICU plural or select,
 * so counts and selects are asserted through attributes and parameters.)
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { ProseNotesMargin, type ProseNotesMarginProps } from '@/components/manuscript/ProseNotesMargin';
import type { ProseFindingView, SceneProseChecksView } from '@/lib/prose-checks/vocabulary';

const findings: ProseFindingView[] = [
    { id: 'f1', ruleId: 'intensifiers', severity: 'NOTE', start: 7, end: 11, matched: 'very', params: { word: 'very' }, suggestion: { start: 7, end: 12, replacement: '' } },
    { id: 'f2', ruleId: 'filter-words', severity: 'NOTE', start: 20, end: 23, matched: 'saw', params: { word: 'saw' }, suggestion: null },
    { id: 'f3', ruleId: 'spelling-variant', severity: 'WARNING', start: 30, end: 36, matched: 'colour', params: { word: 'colour', preferred: 'color', spelling: 'american' }, suggestion: { start: 30, end: 36, replacement: 'color' } },
];

function view(over: Partial<SceneProseChecksView> = {}): SceneProseChecksView {
    return {
        sceneId: 's1',
        status: 'CHECKED',
        checkedRevision: 3,
        textCut: false,
        findingsCut: false,
        wordsChecked: 120,
        readability: { words: 120, sentences: 10, readingEase: 71.4, gradeLevel: 6.2, band: 'plain' },
        styleSheetElementId: 'sheet',
        rulesNotRun: [],
        findings,
        dismissed: 0,
        hiddenByRule: 0,
        ...over,
    };
}

function margin(props: Partial<ProseNotesMarginProps> = {}) {
    const handlers = { onActivate: jest.fn(), onDismiss: jest.fn(), onRuleOff: jest.fn(), onAccept: jest.fn(), onCheckNow: jest.fn() };
    const utils = render(
        <ProseNotesMargin view={view()} placedIds={['f1', 'f2', 'f3']} unplaced={0} layout={{}} activeId={null} canEdit loadError={false} scheduled={null} {...handlers} {...props} />,
    );
    return { ...utils, ...handlers };
}

it('a scene never checked says so, never "no notes", and offers the check', () => {
    const m = margin({ view: view({ status: 'NOT_CHECKED', findings: [], readability: null }), placedIds: [] });
    expect(screen.getByTestId('prose-notes-status')).toHaveTextContent('Not checked yet.');
    expect(screen.getByTestId('prose-notes-status').textContent).not.toMatch(/No notes/);
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(m.onCheckNow).toHaveBeenCalled();
});

it('a checked scene with nothing found says so of the text checked', () => {
    margin({ view: view({ findings: [] }), placedIds: [] });
    expect(screen.getByTestId('prose-notes-status')).toHaveAttribute('data-status', 'CHECKED');
    expect(screen.getByTestId('prose-notes-status')).toHaveTextContent('No notes in the text checked.');
    expect(screen.getByTestId('prose-readability')).toHaveTextContent('Reading ease 71 (plain) · grade 6.2');
});

it('lists the placed notes as buttons named by rule and text, in order', () => {
    margin();
    const buttons = screen.getAllByTestId('prose-note-button');
    // The accessible name is the visible words (rule and text) with the note's place before them.
    expect(buttons.map((b) => b.textContent)).toEqual(['Note 1 of 3: Intensifiersvery', 'Note 2 of 3: Filter wordssaw', 'Note 3 of 3: Spelling varietycolour']);
    expect(screen.getByRole('button', { name: /Note 3 of 3: Spelling variety\s*colour/ })).toBe(buttons[2]);
    expect(screen.getByTestId('prose-notes-list')).toHaveAttribute('aria-label', expect.stringContaining('notes'));
});

it('an open suggestion offers Accept and Reject, worded from the finding', () => {
    const m = margin({ activeId: 'f3' });
    expect(screen.getByTestId('prose-note-detail')).toHaveTextContent(/“colour” is spelt in another variety than your style sheet's .* spelling, which writes “color”\./);
    expect(screen.getByTestId('prose-suggestion')).toHaveTextContent('Suggestion: “colour” → “color”.');
    fireEvent.click(screen.getByTestId('prose-accept'));
    expect(m.onAccept).toHaveBeenCalledWith(findings[2]);
    fireEvent.click(screen.getByTestId('prose-reject'));
    expect(m.onDismiss).toHaveBeenCalledWith(findings[2]);
    fireEvent.click(screen.getByTestId('prose-rule-off'));
    expect(m.onRuleOff).toHaveBeenCalledWith(findings[2]);
});

it('an open note without a suggestion offers Dismiss; a button toggles it open', () => {
    const m = margin({ activeId: 'f2' });
    expect(screen.queryByTestId('prose-accept')).toBeNull();
    fireEvent.click(screen.getByTestId('prose-dismiss'));
    expect(m.onDismiss).toHaveBeenCalledWith(findings[1]);
    fireEvent.click(screen.getAllByTestId('prose-note-button')[0]);
    expect(m.onActivate).toHaveBeenCalledWith('f1');
});

it('a reader sees the notes and no action', () => {
    margin({ activeId: 'f1', canEdit: false });
    expect(screen.getByTestId('prose-note-detail')).toBeInTheDocument();
    expect(screen.queryByTestId('prose-accept')).toBeNull();
    expect(screen.queryByTestId('prose-dismiss')).toBeNull();
    expect(screen.queryByTestId('prose-rule-off')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
});

it('names the notes it could not place and a checked text that was cut', () => {
    margin({ view: view({ textCut: true, wordsChecked: 20_000 }), unplaced: 2 });
    expect(screen.getByText(/could not be placed: the text changed under it/)).toBeInTheDocument();
    expect(screen.getByTestId('prose-notes-status')).toHaveTextContent('in the first 20000 words (only those were checked)');
});

it('has no accessibility violations, open or closed', async () => {
    const { container, rerender } = margin();
    expect(await axe(container)).toHaveNoViolations();
    rerender(<ProseNotesMargin view={view()} placedIds={['f1', 'f2', 'f3']} unplaced={0} layout={{}} activeId="f1" canEdit loadError={false} scheduled={null} onActivate={jest.fn()} onDismiss={jest.fn()} onRuleOff={jest.fn()} onAccept={jest.fn()} onCheckNow={jest.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
});
