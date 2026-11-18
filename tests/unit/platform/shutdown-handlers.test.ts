/**
 * The shutdown handler as installed: registered once per signal, idempotent,
 * the default stages in their order and budgets, and — because `next start`
 * calls `process.exit(143)` straight after its HTTP drain — the stages run
 * BEFORE that exit, never cut short by it.
 */
import {
    SIGNAL_EXIT_CODES,
    _resetShutdownInstalledForTesting,
    defaultShutdownStages,
    installShutdownHandlers,
    type ShutdownHost,
    type ShutdownStage,
} from '@/lib/observability/shutdown';
import {
    SHUTDOWN_CONNECTIONS_MS,
    SHUTDOWN_HTTP_DRAIN_MS,
    SHUTDOWN_OTEL_MS,
    SHUTDOWN_SENTRY_MS,
} from '@/lib/observability/shutdown-budget';

type Listener = () => void;

function fakeHost() {
    const listeners = new Map<string, Listener[]>();
    const exits: number[] = [];
    const host: ShutdownHost & { listeners: typeof listeners; exits: number[] } = {
        listeners,
        exits,
        once(event, listener) {
            listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        },
        exit: ((code?: number) => {
            exits.push(code ?? 0);
        }) as (code?: number) => never,
    };
    return host;
}

const tick = () => new Promise((r) => setImmediate(r));

afterEach(() => {
    _resetShutdownInstalledForTesting();
    jest.useRealTimers();
});

it('registers exactly one SIGTERM and one SIGINT listener, however often it is called', () => {
    const host = fakeHost();
    installShutdownHandlers(() => [], host);
    installShutdownHandlers(() => [], host);
    expect([...host.listeners.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
    expect(host.listeners.get('SIGTERM')).toHaveLength(1);
    expect(host.listeners.get('SIGINT')).toHaveLength(1);
});

it("defers Next's exit until every stage has run, then exits with Next's code", async () => {
    const host = fakeHost();
    const order: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const stages: ShutdownStage[] = [
        { name: 'connections', budgetMs: 1_000, run: async () => { order.push('connections'); await slow; } },
        { name: 'otel', budgetMs: 1_000, run: async () => void order.push('otel') },
    ];
    installShutdownHandlers(() => stages, host, 60_000);
    host.listeners.get('SIGTERM')![0]();

    // Nothing runs until Next has drained and calls exit.
    await tick();
    expect(order).toEqual([]);

    // Next's cleanup, after server.close(): exit(143).
    host.exit(143);
    await tick();
    expect(order).toEqual(['connections']);
    expect(host.exits).toEqual([]); // not yet: a stage is still running

    release();
    for (let i = 0; i < 5 && host.exits.length === 0; i++) await tick();
    expect(order).toEqual(['connections', 'otel']);
    expect(host.exits).toEqual([143]);

    // A second signal starts nothing.
    host.listeners.get('SIGINT')![0]();
    host.exit(130);
    await tick();
    expect(host.exits).toEqual([143]);
});

it('runs the stages and exits itself when nobody calls exit within the drain window', async () => {
    jest.useFakeTimers();
    const host = fakeHost();
    const ran: string[] = [];
    installShutdownHandlers(() => [{ name: 'otel', budgetMs: 1_000, run: async () => void ran.push('otel') }], host, 5_000);
    host.listeners.get('SIGINT')![0]();
    jest.advanceTimersByTime(4_999);
    expect(ran).toEqual([]);
    jest.advanceTimersByTime(1);
    await jest.runAllTimersAsync();
    expect(ran).toEqual(['otel']);
    expect(host.exits).toEqual([SIGNAL_EXIT_CODES.SIGINT]);
});

it('the default stages are connections, then OTel, then Sentry, at their budgets', () => {
    const stages = defaultShutdownStages();
    expect(stages.map((s) => [s.name, s.budgetMs])).toEqual([
        ['connections', SHUTDOWN_CONNECTIONS_MS],
        ['otel', SHUTDOWN_OTEL_MS],
        ['sentry', SHUTDOWN_SENTRY_MS],
    ]);
    expect(SHUTDOWN_HTTP_DRAIN_MS).toBeGreaterThan(0);
});
