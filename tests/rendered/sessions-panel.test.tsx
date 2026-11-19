/**
 * The Settings page's sessions section: lists the person's sessions with this
 * browser marked, and signs others out through the undo-toast convention —
 * the row leaves the list at once, the request goes when the window closes,
 * and Undo cancels it.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Toaster } from 'sonner';
import { SessionsPanel } from '@/components/settings/SessionsPanel';
import type { SessionView } from '@/app-layer/usecases/sessions';

const SESSIONS: SessionView[] = [
    { id: 'row-here', current: true, userAgent: 'Firefox on this laptop', ipAddress: null, createdAt: '2026-11-01T10:00:00.000Z', lastActiveAt: '2026-11-19T09:00:00.000Z' },
    { id: 'row-phone', current: false, userAgent: 'Safari on a phone', ipAddress: null, createdAt: '2026-11-02T10:00:00.000Z', lastActiveAt: '2026-11-18T09:00:00.000Z' },
    { id: 'row-old', current: false, userAgent: null, ipAddress: null, createdAt: '2026-10-02T10:00:00.000Z', lastActiveAt: '2026-10-18T09:00:00.000Z' },
];

let fetchMock: jest.Mock;
beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
    jest.useRealTimers();
});

function mount() {
    return render(
        <>
            <SessionsPanel initialSessions={SESSIONS} />
            <Toaster />
        </>,
    );
}

const list = () => document.getElementById('sessions-list')!;

it('lists every session, marks this browser, and offers no sign-out for it', () => {
    mount();
    expect(within(list()).getAllByRole('listitem')).toHaveLength(3);
    const here = list().querySelector('[data-session-id="row-here"]') as HTMLElement;
    expect(here.textContent).toContain('This browser');
    expect(within(here).queryByRole('button')).toBeNull();
    expect(list().querySelector('[data-session-id="row-old"]')!.textContent).toContain('Unknown browser');
});

it('signing one out removes it at once and sends DELETE when the undo window closes', async () => {
    mount();
    const phone = list().querySelector('[data-session-id="row-phone"]') as HTMLElement;
    fireEvent.click(within(phone).getByRole('button', { name: 'Sign out' }));
    expect(list().querySelector('[data-session-id="row-phone"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
        jest.advanceTimersByTime(6000);
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/account/sessions/row-phone', { method: 'DELETE' });
});

it('"Sign out other sessions" keeps only this browser and POSTs once the window closes', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out other sessions' }));
    expect(within(list()).getAllByRole('listitem')).toHaveLength(1);
    await act(async () => {
        jest.advanceTimersByTime(6000);
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/account/sessions/revoke-others', { method: 'POST' });
});

it('Undo restores the rows and sends nothing', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out other sessions' }));
    await act(async () => {
        jest.advanceTimersByTime(100);
    });
    fireEvent.click(await screen.findByRole('button', { name: /Undo/ }));
    await act(async () => {
        jest.advanceTimersByTime(6000);
    });
    expect(within(list()).getAllByRole('listitem')).toHaveLength(3);
    expect(fetchMock).not.toHaveBeenCalled();
});

it('with only this browser signed in, the bulk action is disabled', () => {
    render(<SessionsPanel initialSessions={[SESSIONS[0]]} />);
    expect(screen.getByRole('button', { name: 'Sign out other sessions' })).toBeDisabled();
    expect(screen.getByText('No other sessions.')).toBeInTheDocument();
});
