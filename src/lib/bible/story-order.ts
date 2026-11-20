/**
 * A story order's ranks (Phase 3.2, decision D22): where a plot beat sits in
 * its act and a timeline event on the timeline, kept in the bible as
 * `BibleElement.orderRank`.
 *
 * A FRACTIONAL RANK. Each rank is a string read as the digits of a fraction in
 * base 36 (`0.k₁k₂k₃…`, digits `0-9a-z`), so ranks compare as plain strings
 * (code-unit order, `compareRanks`) and between any two there is always room
 * for another. Moving an element writes ITS rank alone: a key strictly between
 * its new neighbours', with nobody else's row touched — so a drag is one write
 * (and one bible version), and two people reordering different elements of one
 * book never rewrite each other's rows.
 *
 * Two rules keep the space open:
 *
 *   • a rank never ends in '0' (`0.x0` is `0.x`, and a rank ending in '0'
 *     could have no rank before it at all — nothing sorts below "0");
 *   • a rank is at most `ORDER_RANK_MAX` characters (the migration's CHECK
 *     repeats both). Inserting again and again into ONE gap grows a key by
 *     about one character every five times (each midpoint halves the gap);
 *     appending at either end grows it by one character every 34 times. A key
 *     that would pass the bound is refused (`RankExhaustedError`), never cut;
 *     the usecase then REBALANCES the order (`rebalancedRanks`, Phase 3.H):
 *     every placed element gets a short, evenly spaced rank in the same order,
 *     and the move is computed again.
 *
 * Ordering in SQL is never trusted for ranks: a database collation need not
 * be code-unit order, so the usecases read a scope's ranks and order them
 * here.
 *
 * Client-safe (no imports): the canvas works out a drop's neighbours with the
 * same comparison the server uses.
 */

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

/** A rank's longest form (the migration's CHECK repeats it). */
export const ORDER_RANK_MAX = 64;

/** The shape every stored rank has (the migration's CHECK repeats it). */
export const ORDER_RANK_PATTERN = /^[0-9a-z]{0,63}[1-9a-z]$/;

/** The first rank of an empty order: the middle of the space, room both ways. */
export const FIRST_RANK = 'i';

export function isRank(value: unknown): value is string {
    return typeof value === 'string' && ORDER_RANK_PATTERN.test(value);
}

/** Code-unit comparison: the order ranks are kept in, whatever a database's collation says. */
export function compareRanks(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/** A key that would pass `ORDER_RANK_MAX`: this gap has been split too often. */
export class RankExhaustedError extends Error {
    constructor() {
        super('story order rank would exceed its bound');
        this.name = 'RankExhaustedError';
    }
}

const digit = (c: string) => DIGITS.indexOf(c);

/** The shortest key greater than `a`, with no upper bound. */
function after(a: string): string {
    for (let i = 0; i < a.length; i++) {
        const d = digit(a[i]);
        if (d < BASE - 1) return a.slice(0, i) + DIGITS[d + 1];
    }
    return `${a}1`;
}

/** The shortest key less than `b`, with no lower bound. */
function before(b: string): string {
    for (let i = 0; i < b.length; i++) {
        const d = digit(b[i]);
        if (d >= 2) return b.slice(0, i) + DIGITS[d - 1];
    }
    // Only 0s and 1s (ending in a 1): below the first '1', the largest digit.
    const one = b.indexOf('1');
    return `${b.slice(0, one)}0${DIGITS[BASE - 1]}`;
}

/** A key strictly between `a` and `b` (a < b), near the middle of the gap. */
function midpoint(a: string, b: string): string {
    let out = '';
    let upper: string | null = b;
    for (let i = 0; ; i++) {
        const da = i < a.length ? digit(a[i]) : 0;
        const db = upper !== null && i < upper.length ? digit(upper[i]) : BASE;
        if (da === db) {
            out += DIGITS[da];
            continue;
        }
        const mid = Math.floor((da + db) / 2);
        if (mid > da) return out + DIGITS[mid];
        // Adjacent digits: keep a's, and from here on only a bounds the key
        // (whatever follows, this position already sorts it below b).
        out += DIGITS[da];
        upper = null;
    }
}

/**
 * A rank strictly between `lower` and `upper`; `null` is an open end.
 * Throws a `RangeError` for a rank that is not one or a gap that is not one
 * (`lower >= upper`), and `RankExhaustedError` past `ORDER_RANK_MAX`.
 */
export function rankBetween(lower: string | null, upper: string | null): string {
    if (lower !== null && !isRank(lower)) throw new RangeError('lower is not a rank');
    if (upper !== null && !isRank(upper)) throw new RangeError('upper is not a rank');
    if (lower !== null && upper !== null && compareRanks(lower, upper) >= 0) throw new RangeError('lower is not below upper');
    const key = lower === null ? (upper === null ? FIRST_RANK : before(upper)) : upper === null ? after(lower) : midpoint(lower, upper);
    if (key.length > ORDER_RANK_MAX) throw new RankExhaustedError();
    return key;
}

/** Where an element is asked to go, by the ranked elements either side of it. */
export interface RankPlacement {
    /** The rank it should follow, or null: the start (of its act, for a beat). */
    after: string | null;
    /** The rank it should precede, or null: the end. */
    before: string | null;
}

export type RankDecision = { ok: true; rank: string } | { ok: false; reason: 'ORDER_STALE' | 'ORDER_RANK_EXHAUSTED' };

/**
 * The rank for an element placed between two ranked neighbours, given every
 * OTHER rank of the order (the element's own left out: it vacates its place).
 *
 * The neighbours are the ones the author SAW (a plot board lane shows one act,
 * so a lane's neighbours may have another act's beats between them in the
 * order). The new rank is strictly between the two AND between `after` and
 * the very next rank of the whole order, so it can never equal another's: the
 * rank is unique per order without reading anyone's act. `ORDER_STALE` when
 * the neighbours no longer stand in that order (someone moved one meanwhile).
 */
export function placeRank(others: readonly string[], placement: RankPlacement): RankDecision {
    const sorted = [...others].sort(compareRanks);
    const has = (r: string) => sorted.includes(r);
    if ((placement.after !== null && !has(placement.after)) || (placement.before !== null && !has(placement.before))) return { ok: false, reason: 'ORDER_STALE' };
    if (placement.after !== null && placement.before !== null && compareRanks(placement.after, placement.before) >= 0) return { ok: false, reason: 'ORDER_STALE' };
    let lower: string | null;
    let upper: string | null;
    if (placement.after !== null) {
        lower = placement.after;
        upper = sorted.find((r) => compareRanks(r, placement.after!) > 0) ?? null;
    } else if (placement.before !== null) {
        upper = placement.before;
        lower = [...sorted].reverse().find((r) => compareRanks(r, placement.before!) < 0) ?? null;
    } else {
        // Nothing either side: the end of the whole order.
        lower = sorted.length > 0 ? sorted[sorted.length - 1] : null;
        upper = null;
    }
    try {
        return { ok: true, rank: rankBetween(lower, upper) };
    } catch (err) {
        if (err instanceof RankExhaustedError) return { ok: false, reason: 'ORDER_RANK_EXHAUSTED' };
        throw err;
    }
}

/**
 * Short, evenly spaced ranks for `count` elements, in ascending order (Phase
 * 3.H, issue #50 item 7): what a REBALANCE gives an order whose gap is spent.
 * Every rank has the same length L, the fewest digits with room for at least
 * 36 free keys between any two neighbours (36^L ≥ 37 × (count + 1)), so after a
 * rebalance a gap takes about five more inserts per digit before it is spent
 * again, as a fresh order does. Trailing zeros are dropped (a rank never ends
 * in '0'), which keeps the code-unit order of the strings the order of the
 * fractions. Deterministic: the same count gives the same ranks.
 */
export function rebalancedRanks(count: number): string[] {
    if (!Number.isInteger(count) || count < 0) throw new RangeError('count is not a count');
    if (count === 0) return [];
    let length = 1;
    let space = BigInt(BASE);
    const need = BigInt(BASE + 1) * BigInt(count + 1);
    while (space < need) {
        space *= BigInt(BASE);
        length++;
    }
    if (length > ORDER_RANK_MAX) throw new RankExhaustedError();
    const step = space / BigInt(count + 1);
    const out: string[] = [];
    for (let i = 1; i <= count; i++) {
        const digits = (step * BigInt(i)).toString(BASE).padStart(length, '0');
        let end = digits.length;
        while (digits[end - 1] === '0') end--;
        out.push(digits.slice(0, end));
    }
    return out;
}
