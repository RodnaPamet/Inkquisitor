/**
 * The client address of a request, as every rate-limit tier keys on it.
 *
 * ── WHY NOT THE LEFTMOST X-Forwarded-For ENTRY ───────────────────────
 *
 * Each proxy a request passes APPENDS the address it received the request
 * from, so the header reads `<what the client sent>, …, <what proxy 1 saw>`.
 * Everything to the left of the entries our own proxies wrote is whatever the
 * client chose to send. The tiers used to key on the LEFTMOST entry, so a
 * client that sent `X-Forwarded-For: <random>` on every request was charged
 * to a fresh bucket each time: the auth tier, LOGIN_LIMIT and the sign-up
 * budget became unlimited for anyone who set one header (issue #5).
 *
 * ── THE RULE ─────────────────────────────────────────────────────────
 *
 * `TRUSTED_PROXY_HOPS` (src/env.ts, default 1: production runs behind one
 * Caddy on our own VM) says how many proxies in front of this process append
 * to the header. The client is the entry that many positions from the RIGHT:
 * with one hop, the last entry, which Caddy wrote and the client cannot
 * forge. A spoofed leftmost entry is ignored, so the spoofer is charged to
 * their real address's bucket.
 *
 *   hops = 0          no forwarded header is trusted. The process cannot see
 *                     a socket address from a route handler or the proxy, so
 *                     every request shares the `UNKNOWN_CLIENT` bucket — the
 *                     safe direction: one shared budget, never one per header.
 *   header absent     (a request that did not pass through the proxy: a local
 *                     probe, a test) `UNKNOWN_CLIENT`.
 *   fewer entries     than hops: the leftmost entry, the one written by the
 *                     outermost proxy that was there. Never further left.
 *   entry malformed   (not an IPv4 or IPv6 literal, by a real parser) `UNKNOWN_CLIENT`: the
 *                     entry a trusted proxy wrote is always an address, so a
 *                     malformed one means the configuration is not what it
 *                     says, and a string a client typed must not become a key.
 *
 * `X-Real-IP` is not read: Caddy does not set it and passes a client's own
 * through, so it is exactly as forgeable as the leftmost entry.
 *
 * ONE ADDRESS, ONE STRING, AND AN IPv6 CLIENT IS ITS /64. The address is
 * parsed and written back canonically (`normaliseAddress`), so
 * `2001:db8::1` and `2001:DB8:0:0::1` are one client and an IPv4-mapped
 * address is the IPv4 one. The tiers key on `clientRateLimitKeyFrom`, which
 * masks an IPv6 address to its /64 prefix: a subscriber holds a whole /64 and
 * would otherwise choose among 2^64 buckets.
 *
 * Read in ONE place (`trustedProxyHops`), used by the edge auth and read tiers
 * (src/lib/rate-limit/window-store.ts), the Node mutation tier and LOGIN_LIMIT
 * (src/lib/security/rate-limit-middleware.ts) and the session record
 * (src/lib/security/session-tracker.ts). No Node built-ins, so the proxy
 * bundle stays runtime-neutral.
 */
import { env } from '@/env';

/** The bucket every request whose address cannot be trusted shares. */
export const UNKNOWN_CLIENT = 'unknown';

/** The configured hop count; anything unreadable is the default, 1. */
export function trustedProxyHops(): number {
    // t3-env coerces it to a number; the Jest mock answers the raw string.
    const raw: unknown = env.TRUSTED_PROXY_HOPS;
    const hops = typeof raw === 'number' ? raw : Number(raw ?? 1);
    return Number.isInteger(hops) && hops >= 0 && hops <= 10 ? hops : 1;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

/** `a.b.c.d` → its two 16-bit groups, or null. */
function ipv4Groups(value: string): [number, number] | null {
    if (!IPV4.test(value)) return null;
    const [a, b, c, d] = value.split('.').map(Number);
    return [(a << 8) | b, (c << 8) | d];
}

/**
 * The eight 16-bit groups of an IPv6 literal, or null when it is not one.
 * A real parser, not a character-class match: at most one `::`, standing for
 * at least one zero group; every group 1–4 hex digits; an embedded IPv4 only
 * as the last two groups; exactly eight groups in all. So `:::::::`, `a:b`,
 * `1:2:3:4:5:6:7:8:9`, `1::2::3` and `::g` are all refused. No zone id (`%…`):
 * a proxy never writes one. Kept free of `node:net` because the proxy's
 * import graph is (tests/guards/proxy-imports-no-node-only-module.test.ts).
 */
export function parseIpv6(value: string): number[] | null {
    if (!value.includes(':')) return null;
    const halves = value.split('::');
    if (halves.length > 2) return null;
    const parse = (part: string, mayEndInIpv4: boolean): number[] | null => {
        if (part === '') return [];
        const fields = part.split(':');
        const groups: number[] = [];
        for (let i = 0; i < fields.length; i++) {
            const f = fields[i];
            if (mayEndInIpv4 && i === fields.length - 1 && f.includes('.')) {
                const v4 = ipv4Groups(f);
                if (!v4) return null;
                groups.push(...v4);
            } else if (HEXTET.test(f)) {
                groups.push(parseInt(f, 16));
            } else {
                return null;
            }
        }
        return groups;
    };
    if (halves.length === 1) {
        const groups = parse(halves[0], true);
        return groups && groups.length === 8 ? groups : null;
    }
    const head = parse(halves[0], false);
    const tail = parse(halves[1], true);
    if (!head || !tail || head.length + tail.length > 7) return null;
    return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/** RFC 5952 text of eight groups: lowercase, no leading zeros, the longest run (≥ 2) of zero groups as `::`. */
function formatIpv6(groups: readonly number[]): string {
    let bestStart = -1;
    let bestLength = 0;
    for (let i = 0; i < 8; ) {
        if (groups[i] !== 0) {
            i++;
            continue;
        }
        let j = i;
        while (j < 8 && groups[j] === 0) j++;
        if (j - i > bestLength) {
            bestStart = i;
            bestLength = j - i;
        }
        i = j;
    }
    const hex = groups.map((g) => g.toString(16));
    if (bestLength < 2) return hex.join(':');
    return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

/** True for `::ffff:a.b.c.d` (any spelling): an IPv4 client seen through a dual-stack socket. */
function isIpv4Mapped(groups: readonly number[]): boolean {
    return groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
}

/**
 * The entry as ONE canonical address, or null when it is not one. Accepts the
 * forms a proxy writes: `1.2.3.4`, `1.2.3.4:5678`, `2001:db8::1`,
 * `[2001:db8::1]:5678`. Every spelling of one address gives one string, so it
 * cannot be varied to open a fresh bucket: IPv6 in RFC 5952 form
 * (`2001:DB8:0:0::1` → `2001:db8::1`), and an IPv4-mapped IPv6 address as the
 * IPv4 address it carries (`::ffff:192.0.2.1` → `192.0.2.1`).
 */
export function normaliseAddress(entry: string): string | null {
    let value = entry.trim().toLowerCase();
    if (value.length === 0 || value.length > 64) return null;
    const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
    if (bracketed) value = bracketed[1];
    else if (/^[\d.]+:\d{1,5}$/.test(value)) value = value.slice(0, value.lastIndexOf(':'));
    if (IPV4.test(value)) return bracketed ? null : value;
    const groups = parseIpv6(value);
    if (!groups) return null;
    if (isIpv4Mapped(groups)) return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    return formatIpv6(groups);
}

/**
 * The rate-limit key for a canonical address (`clientIpFrom`'s answer). An
 * IPv4 address is its own key. An IPv6 address is keyed on its /64: one
 * subscriber is routinely handed a whole /64 and can pick any of its 2^64
 * addresses per request, so keying the full address gave them 2^64 buckets.
 * `UNKNOWN_CLIENT` stays the shared bucket.
 */
export function rateLimitKeyFor(address: string): string {
    if (address === UNKNOWN_CLIENT || IPV4.test(address)) return address;
    const groups = parseIpv6(address);
    if (!groups) return UNKNOWN_CLIENT;
    return `${formatIpv6([...groups.slice(0, 4), 0, 0, 0, 0])}/64`;
}

/** The client address `headers` name under `hops` trusted proxies; `UNKNOWN_CLIENT` when it cannot be trusted. */
export function clientIpFrom(headers: Headers, hops: number = trustedProxyHops()): string {
    if (hops <= 0) return UNKNOWN_CLIENT;
    const forwarded = headers.get('x-forwarded-for');
    if (!forwarded) return UNKNOWN_CLIENT;
    const entries = forwarded
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e !== '');
    if (entries.length === 0) return UNKNOWN_CLIENT;
    const chosen = entries[Math.max(0, entries.length - hops)];
    return normaliseAddress(chosen) ?? UNKNOWN_CLIENT;
}

/**
 * The key every rate-limit tier charges a request to: `clientIpFrom`, with an
 * IPv6 client masked to its /64 (`rateLimitKeyFor`). The session record keeps
 * the full address (`clientIpFrom`); budgets are spent per key.
 */
export function clientRateLimitKeyFrom(headers: Headers, hops: number = trustedProxyHops()): string {
    return rateLimitKeyFor(clientIpFrom(headers, hops));
}
