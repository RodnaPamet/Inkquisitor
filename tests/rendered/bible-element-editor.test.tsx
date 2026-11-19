/**
 * The element page's editor save path (Phase 1.2): an edit is saved through
 * the 1.1 fields API after the debounce, once, with the field's key and the
 * latest value; a refused or failed save keeps the edit on screen, says so,
 * and sends it again on Retry; the element's own columns go through PATCH.
 * And the Enrich button is disabled with its reason as a tooltip.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { Toaster } from 'sonner';

const push = jest.fn();
const refresh = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push, refresh, replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1/elements/el_1',
    useSearchParams: () => new URLSearchParams(),
}));

import { ElementPage } from '@/components/bible/ElementPage';
import { AUTOSAVE_DEBOUNCE_MS } from '@/components/bible/use-element-autosave';
import { API, elementView, mockFetch, pageProps } from '../helpers/bible-ui';

// TipTap (the rich-text fields) calls document.elementFromPoint while mounting; jsdom has none.
beforeAll(() => {
    Document.prototype.elementFromPoint = () => null;
});
beforeEach(() => {
    jest.useFakeTimers();
    push.mockClear();
    refresh.mockClear();
});
afterEach(() => {
    jest.useRealTimers();
});

const FIELDS_URL = `${API}/elements/el_1/fields`;
const saved = (values: Record<string, string> = {}, versionNumber = 4) => ({ json: { element: { ...elementView({ values, versionNumber }), changedKeys: Object.keys(values) } } });

function mount() {
    return render(
        <>
            <ElementPage {...pageProps()} />
            <Toaster />
        </>,
    );
}

const roleInput = () => screen.getByTestId('field-input-role') as HTMLInputElement;
const status = () => screen.getByTestId('save-status');

async function elapse(ms: number) {
    await act(async () => {
        jest.advanceTimersByTime(ms);
    });
}

it('saves an edit once, after the debounce, with the field key and the latest value', async () => {
    const { requests } = mockFetch({ [`PUT ${FIELDS_URL}`]: saved({ role: 'Ferrywoman' }) });
    mount();

    fireEvent.change(roleInput(), { target: { value: 'Ferry' } });
    await elapse(AUTOSAVE_DEBOUNCE_MS - 100);
    fireEvent.change(roleInput(), { target: { value: 'Ferrywoman' } });
    expect(status()).toHaveAttribute('data-state', 'pending');
    await elapse(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(requests).toHaveLength(0);

    await elapse(1);
    expect(requests).toEqual([{ method: 'PUT', url: FIELDS_URL, body: { fields: [{ key: 'role', value: 'Ferrywoman' }] } }]);
    expect(status()).toHaveAttribute('data-state', 'saved');
    expect(status()).toHaveTextContent('All changes saved');
});

it('clearing a field sends null, which the API reads as "clear"', async () => {
    const { requests } = mockFetch({ [`PUT ${FIELDS_URL}`]: saved() });
    render(<ElementPage {...pageProps({ element: elementView({ values: { role: 'Ferrywoman' } }) })} />);
    fireEvent.change(roleInput(), { target: { value: '' } });
    await elapse(AUTOSAVE_DEBOUNCE_MS);
    expect(requests[0]?.body).toEqual({ fields: [{ key: 'role', value: null }] });
});

it('a failed save keeps the edit, says it was not saved, and Retry sends it again', async () => {
    let fail = true;
    const { requests } = mockFetch({
        [`PUT ${FIELDS_URL}`]: () =>
            fail ? { status: 400, json: { error: { code: 'BAD_REQUEST', message: 'x', details: { reason: 'FIELD_VALUES_REFUSED', fields: [{ key: 'role', reason: 'TOO_LONG' }] } } } } : saved({ role: 'Ferrywoman' }),
    });
    mount();

    fireEvent.change(roleInput(), { target: { value: 'Ferrywoman' } });
    await elapse(AUTOSAVE_DEBOUNCE_MS);
    expect(requests).toHaveLength(1);
    expect(status()).toHaveAttribute('data-state', 'error');
    expect(status()).toHaveTextContent('Not saved: Some values were not accepted.');
    // The edit is still on screen, and the refused field says so.
    expect(roleInput().value).toBe('Ferrywoman');
    expect(screen.getByText('This value was not accepted. Change it and it will save again.')).toBeInTheDocument();

    fail = false;
    fireEvent.click(within(status()).getByRole('button', { name: 'Retry' }));
    await elapse(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(status()).toHaveAttribute('data-state', 'saved');
});

it('an edit made after a failure goes out with the failed one, the newer value winning', async () => {
    let fail = true;
    const { requests } = mockFetch({ [`PUT ${FIELDS_URL}`]: () => (fail ? { status: 500, json: {} } : saved()) });
    mount();
    fireEvent.change(roleInput(), { target: { value: 'Ferry' } });
    await elapse(AUTOSAVE_DEBOUNCE_MS);
    expect(status()).toHaveTextContent('Not saved: Something went wrong. Your changes are kept; try again.');

    fail = false;
    fireEvent.change(screen.getByTestId('field-input-want'), { target: { value: 'To cross' } });
    fireEvent.change(roleInput(), { target: { value: 'Ferrywoman' } });
    await elapse(AUTOSAVE_DEBOUNCE_MS);
    expect(requests).toHaveLength(2);
    const fields = (requests[1].body as { fields: Array<{ key: string }> }).fields;
    expect([...fields].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
        { key: 'role', value: 'Ferrywoman' },
        { key: 'want', value: 'To cross' },
    ]);
});

it('a change to the name goes through PATCH on the element, never the fields API', async () => {
    const { requests } = mockFetch({ [`PATCH ${API}/elements/el_1`]: { json: { element: elementView({ name: 'Mara Vell', versionNumber: 4 }) } } });
    mount();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Mara Vell' } });
    await elapse(AUTOSAVE_DEBOUNCE_MS);
    expect(requests).toEqual([{ method: 'PATCH', url: `${API}/elements/el_1`, body: { name: 'Mara Vell' } }]);
});

it('an emptied name is not sent: the field says it needs one', async () => {
    const { requests } = mockFetch({});
    mount();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: '  ' } });
    await elapse(AUTOSAVE_DEBOUNCE_MS);
    expect(requests).toHaveLength(0);
    expect(screen.getByText('An entry needs a name; the last saved name is kept.')).toBeInTheDocument();
});

it('emptying the name drops the keystroke still waiting, so the last saved name stands', async () => {
    const { requests } = mockFetch({});
    mount();
    const name = screen.getByLabelText(/^Name/);
    // Deleting "Mara" a letter at a time: "M" is queued, then the name is empty.
    fireEvent.change(name, { target: { value: 'M' } });
    fireEvent.change(name, { target: { value: '' } });
    await elapse(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(requests).toHaveLength(0);
    expect(status()).not.toHaveAttribute('data-state', 'pending');
});

it('a custom entry\'s label: the header follows what is typed, and an emptied label is not sent and says why', async () => {
    const { requests } = mockFetch({ [`PATCH ${API}/elements/el_1`]: { json: { element: elementView({ kind: 'CUSTOM', customLabel: 'Prophecy', versionNumber: 4 }) } } });
    render(<ElementPage {...pageProps({ element: elementView({ kind: 'CUSTOM', customLabel: 'Omen' }) })} />);
    const label = screen.getByLabelText(/^Custom kind/);
    fireEvent.change(label, { target: { value: 'Prophecy' } });
    expect(screen.getByText('Custom element · Prophecy')).toBeInTheDocument();
    await elapse(AUTOSAVE_DEBOUNCE_MS);
    expect(requests).toEqual([{ method: 'PATCH', url: `${API}/elements/el_1`, body: { customLabel: 'Prophecy' } }]);

    fireEvent.change(label, { target: { value: 'P' } });
    fireEvent.change(label, { target: { value: ' ' } });
    await elapse(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(requests).toHaveLength(1);
    expect(screen.getByText('A custom entry needs its own label; the last saved label is kept.')).toBeInTheDocument();
});

it('leaving the page mid-debounce saves the edit, then has the page now shown re-read', async () => {
    const { requests } = mockFetch({ [`PUT ${FIELDS_URL}`]: saved({ role: 'Ferrywoman' }) });
    const view = mount();
    fireEvent.change(roleInput(), { target: { value: 'Ferrywoman' } });
    // A client-side navigation renders the next page, then unmounts this one.
    view.unmount();
    await elapse(0);
    expect(requests).toEqual([{ method: 'PUT', url: FIELDS_URL, body: { fields: [{ key: 'role', value: 'Ferrywoman' }] } }]);
    expect(refresh).toHaveBeenCalledTimes(1);
});

it('leaving the page after a failed save sends the kept edit once more', async () => {
    let fail = true;
    const { requests } = mockFetch({ [`PUT ${FIELDS_URL}`]: () => (fail ? { status: 500, json: {} } : saved({ role: 'Ferrywoman' })) });
    const view = mount();
    fireEvent.change(roleInput(), { target: { value: 'Ferrywoman' } });
    await elapse(AUTOSAVE_DEBOUNCE_MS);
    expect(status()).toHaveAttribute('data-state', 'error');
    expect(requests).toHaveLength(1);

    fail = false;
    view.unmount();
    await elapse(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(refresh).toHaveBeenCalledTimes(1);
});

it('rich text written in the editor\'s markdown mode is saved as escaped HTML paragraphs', async () => {
    const { requests } = mockFetch({ [`PUT ${FIELDS_URL}`]: saved() });
    mount();
    const wound = await screen.findByTestId('field-richtext-wound');
    fireEvent.click(await within(wound).findByTestId('rich-text-editor-toggle'));
    fireEvent.change(within(wound).getByTestId('rich-text-editor-textarea'), { target: { value: 'Lost the <boat>\n\nAnd the map' } });
    await elapse(AUTOSAVE_DEBOUNCE_MS);
    const last = requests[requests.length - 1];
    expect(last.body).toEqual({ fields: [{ key: 'wound', value: '<p>Lost the &lt;boat&gt;</p><p>And the map</p>' }] });
});

it('switching the rich-text editor between its modes saves nothing, and coming back keeps the formatting', async () => {
    const { requests } = mockFetch({ [`PUT ${FIELDS_URL}`]: saved() });
    render(<ElementPage {...pageProps({ element: elementView({ values: { wound: '<p><strong>Lost</strong> the boat</p>' } }) })} />);
    const wound = await screen.findByTestId('field-richtext-wound');
    const toggle = await within(wound).findByTestId('rich-text-editor-toggle');
    // Into markdown mode (the editor reports its plain text) and back again.
    fireEvent.click(toggle);
    expect(within(wound).getByTestId('rich-text-editor-textarea')).toHaveValue('Lost the boat');
    await elapse(AUTOSAVE_DEBOUNCE_MS);
    fireEvent.click(within(wound).getByTestId('rich-text-editor-toggle'));
    await elapse(AUTOSAVE_DEBOUNCE_MS);
    expect(requests).toHaveLength(0);
    expect(within(wound).getByTestId('rich-text-editor-content').querySelector('strong')).toHaveTextContent('Lost');
    // The keyboard stays where it was: on the mode toggle.
    expect(within(wound).getByTestId('rich-text-editor-toggle')).toHaveFocus();
});

it('a choice field saves the option value, and its clear button sends null', async () => {
    const { requests } = mockFetch({ [`PUT ${FIELDS_URL}`]: saved() });
    render(<ElementPage {...pageProps({ element: elementView({ values: { prominence: 'major' } }) })} />);
    const field = document.querySelector('[data-field-key="prominence"]') as HTMLElement;
    expect(field).toHaveTextContent('Major presence');
    fireEvent.click(within(field).getByRole('button', { name: 'Clear Prominence' }));
    await elapse(AUTOSAVE_DEBOUNCE_MS);
    expect(requests[0].body).toEqual({ fields: [{ key: 'prominence', value: null }] });
});

it('a scale field saves the number picked', async () => {
    const { requests } = mockFetch({ [`PUT ${FIELDS_URL}`]: saved() });
    mount();
    const field = document.querySelector('[data-field-key="agency"]') as HTMLElement;
    fireEvent.click(within(field).getByRole('radio', { name: '4' }));
    await elapse(AUTOSAVE_DEBOUNCE_MS);
    expect(requests[0].body).toEqual({ fields: [{ key: 'agency', value: 4 }] });
});

it('a list field sends its items, leaving blank rows out', async () => {
    const { requests } = mockFetch({ [`PUT ${FIELDS_URL}`]: saved() });
    render(<ElementPage {...pageProps({ element: elementView({ values: { defining_traits: ['stubborn'] } }) })} />);
    const field = screen.getByTestId('field-list-defining_traits');
    fireEvent.click(within(field).getByRole('button', { name: 'Add item' }));
    fireEvent.change(within(field).getByLabelText('Defining traits, item 2'), { target: { value: 'kind' } });
    fireEvent.click(within(field).getByRole('button', { name: 'Add item' }));
    await elapse(AUTOSAVE_DEBOUNCE_MS);
    expect(requests[requests.length - 1].body).toEqual({ fields: [{ key: 'defining_traits', value: ['stubborn', 'kind'] }] });
});

it('Enrich is disabled, and says why: enrichment arrives with interviews', async () => {
    mockFetch({});
    mount();
    const enrich = screen.getByRole('button', { name: 'Enrich' });
    expect(enrich).toHaveAttribute('aria-disabled', 'true');
    expect(enrich).toHaveAccessibleDescription('Enrichment arrives with interviews');
});

it('has no axe violations, editable or read-only', async () => {
    jest.useRealTimers();
    mockFetch({});
    const editable = render(<ElementPage {...pageProps({ element: elementView({ values: { prominence: 'major', defining_traits: ['stubborn'] } }) })} />);
    expect(await axe(editable.container)).toHaveNoViolations();
    editable.unmount();
    const readOnly = render(<ElementPage {...pageProps({ canEdit: false })} />);
    expect(await axe(readOnly.container)).toHaveNoViolations();
});
