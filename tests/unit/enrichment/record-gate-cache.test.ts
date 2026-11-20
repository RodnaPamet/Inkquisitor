/**
 * The reconcile gate's verdict cache lives on `globalThis` (shared by every
 * module graph of the process, issue #36 item 7), so it outlives a module
 * graph. A graph reloaded with ANOTHER committed record (`next dev` after the
 * evaluation was re-run, or a broken record) must get the verdict on that
 * record, never the one cached for the graph before it: the cache is keyed by
 * content, not by the mode alone.
 */
import committed from '@/lib/enrichment/evals/evaluation-record.json';

type Gate = typeof import('@/lib/enrichment/record-gate');

function gateWith(record: unknown | null): Gate {
    let gate!: Gate;
    jest.isolateModules(() => {
        if (record !== null) jest.doMock('@/lib/enrichment/evals/evaluation-record.json', () => record);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        gate = require('@/lib/enrichment/record-gate') as Gate;
    });
    jest.dontMock('@/lib/enrichment/evals/evaluation-record.json');
    return gate;
}

it('a reloaded graph with a broken record is refused, though the graph before it mounted on the good one', async () => {
    expect(await gateWith(null).reconcileGate('structural')).toEqual({ mounted: true, recordKind: 'structural' });
    const broken = { ...(committed as Record<string, unknown>), promptHash: `sha256:${'0'.repeat(64)}` };
    expect(await gateWith(broken).reconcileGate('structural')).toMatchObject({ mounted: false, reason: 'NO_PASSING_RECORD' });
    // And the good record is still answered from its own entry.
    expect(await gateWith(null).reconcileGate('structural')).toEqual({ mounted: true, recordKind: 'structural' });
});
