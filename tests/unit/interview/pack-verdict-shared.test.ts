/**
 * The pack verdicts are shared by every module graph of the process (issue
 * #36, item 7). Next compiles the instrumentation hook and the routes into
 * separate graphs, each with its own copy of every module; the start-up
 * warm-up filled ITS copy's cache and the first `GET interview-packs` replayed
 * every record again, on the request path. Two isolated module registries
 * stand in for the two graphs here, and the measure is COUNTED work — record
 * replays — never a wall clock.
 */
type Graph = { mount: typeof import('@/lib/interview/pack-mount'); packs: typeof import('@/lib/interview/packs'); evaluation: typeof import('@/lib/interview/pack-evaluation') };

async function loadGraph(): Promise<Graph> {
    let graph!: Graph;
    await jest.isolateModulesAsync(async () => {
        graph = {
            mount: await import('@/lib/interview/pack-mount'),
            packs: await import('@/lib/interview/packs'),
            evaluation: await import('@/lib/interview/pack-evaluation'),
        };
    });
    return graph;
}

it('a warm-up in one graph means the other graph replays no record', async () => {
    const warmUp = await loadGraph();
    const route = await loadGraph();
    expect(route.mount).not.toBe(warmUp.mount); // two copies of the module, as Next has
    const warmReplays = jest.spyOn(warmUp.evaluation, 'checkPackRecord');
    const routeReplays = jest.spyOn(route.evaluation, 'checkPackRecord');

    const warmed = await warmUp.mount.packMounts(warmUp.packs.getPacks(), 'structural');
    expect(warmReplays.mock.calls.length).toBe(Object.keys(warmUp.packs.getPacks().files).length);

    const read = await route.mount.packMounts(route.packs.getPacks(), 'structural');
    expect(routeReplays).not.toHaveBeenCalled();
    expect([...read.values()].map((v) => v.ok)).toEqual([...warmed.values()].map((v) => v.ok));
});

it('a pack whose record differs is judged on its own, never served another’s verdict', async () => {
    const g = await loadGraph();
    const registry = g.packs.getPacks();
    const name = Object.keys(registry.files)[0];
    const file = registry.files[name];
    if (file.record.state !== 'present') throw new Error('expected a committed record');
    const altered = { ...registry, files: { ...registry.files, [name]: { ...file, record: { ...file.record, raw: { ...(file.record.raw as object), promptHash: `sha256:${'0'.repeat(64)}` } } } } };
    const verdicts = await g.mount.packMounts(altered, 'structural', [name]);
    expect(verdicts.get(name)).toMatchObject({ ok: false, reason: 'PROMPT_HASH_MISMATCH' });
});
