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
 *   entry malformed   (not an IPv4 or IPv6 literal) `UNKNOWN_CLIENT`: the
 *                     entry a trusted proxy wrote is always an address, so a
 *                     malformed one means the configuration is not what it
 *                     says, and a string a client typed must not become a key.
 *
 * `X-Real-IP` is not read: Caddy does not set it and passes a client's own
 * through, so it is exactly as forgeable as the leftmost entry.
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
const IPV6 = /^[0-9a-f:]+(?:\.(?:\d{1,3}\.){2}\d{1,3}\.?\d{0,3})?$/;

/**
 * The entry as a canonical address, or null when it is not one. Accepts the
 * forms a proxy writes: `1.2.3.4`, `1.2.3.4:5678`, `2001:db8::1`,
 * `[2001:db8::1]:5678`.
 */
export function normaliseAddress(entry: string): string | null {
    let value = entry.trim().toLowerCase();
    if (value.length === 0 || value.length > 64) return null;
    const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
    if (bracketed) value = bracketed[1];
    else if (/^[\d.]+:\d{1,5}$/.test(value)) value = value.slice(0, value.lastIndexOf(':'));
    if (IPV4.test(value)) return value;
    if (value.includes(':') && IPV6.test(value) && value.split(':').length <= 8 + 1 && value.length <= 45) return value;
    return null;
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
