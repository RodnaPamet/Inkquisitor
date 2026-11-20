/**
 * A cache shared by every bundle of ONE Node process (issue #36, item 7).
 *
 * Next compiles the instrumentation hook and each route into separate module
 * graphs, so a module-scope `Map` in a module both import exists once PER
 * GRAPH: the start-up warm-up filled the instrumentation's copy of the pack
 * verdict cache and the first `GET interview-packs` replayed every pack's
 * record again, for seconds of CPU on the request path. A map held on
 * `globalThis` under a registered symbol is one map for the process, whichever
 * graph asks.
 *
 * Only for values that are a pure function of their key, where the key names
 * everything the value depends on (content hashes, never an object's
 * identity, which differs between graphs). Never for anything per request,
 * per workspace or per person.
 */
const REGISTRY = Symbol.for('inkquisitor.processSharedCaches');

type Holder = { [REGISTRY]?: Map<string, Map<string, unknown>> };

/** The process's map named `name`, created on first use. */
export function processSharedMap<V>(name: string): Map<string, V> {
    const holder = globalThis as unknown as Holder;
    const all = (holder[REGISTRY] ??= new Map());
    let map = all.get(name);
    if (!map) all.set(name, (map = new Map()));
    return map as Map<string, V>;
}
