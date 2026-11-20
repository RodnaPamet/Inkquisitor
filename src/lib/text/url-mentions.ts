/**
 * Every address a piece of text names: a URL with a scheme or `www.`, and a
 * BARE DOMAIN with neither (`attacker.example/collect`, `mail me at
 * bob@evil.test`), Phase 2.H (issue #39 item 4).
 *
 * Enrichment and research refuse a proposed value that names an address no
 * clean source gives verbatim (the model was told to put it there). They read
 * only scheme and `www.` URLs, so a bare domain passed. A bare domain is
 * recognised by its shape and a top-level domain from `TOP_LEVEL_DOMAINS` (a
 * closed list of the common ones, and the reserved `example`, `test`,
 * `invalid` and `localhost`): every word with a dot in it would refuse
 * "file.txt" and an abbreviation typed without a space. The cost of a miss is
 * an address a person still reads before accepting; the cost of a false hit
 * is one refused suggestion.
 *
 * No regular expression here nests a quantifier: a token is split on
 * whitespace, trimmed character by character, and its host split on dots.
 */

const SCHEMED_URL = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

/** Common top-level domains and the reserved names attackers' examples use. Lower case. */
export const TOP_LEVEL_DOMAINS: ReadonlySet<string> = new Set(
    (
        'com net org edu gov mil int info biz name pro mobi xyz top site online club shop store tech blog news live cloud page link click ' +
        'app dev io ai co me ly gg tv fm am to sh ws cc ac ' +
        'us uk de fr es it nl be ch at se no dk fi pl cz pt gr ie ru ua by bg ro hu rs hr si sk lt lv ee tr il in cn jp kr tw hk sg au nz ca mx br ar cl za ' +
        'eu asia onion example test invalid localhost'
    ).split(' '),
);

const LEADING = new Set(['(', '[', '{', '<', '"', "'", '“', '‘', '«']);
const TRAILING = new Set([')', ']', '}', '>', '"', "'", '”', '’', '»', ',', ';', ':', '!', '?', '.']);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function trim(token: string): string {
    let start = 0;
    let end = token.length;
    while (start < end && LEADING.has(token[start])) start++;
    while (end > start && TRAILING.has(token[end - 1])) end--;
    return token.slice(start, end);
}

/** The host a bare-domain token names (after any `user@`, before any path, port, query or fragment), or null. */
function bareHost(token: string): string | null {
    let t = trim(token);
    if (t === '' || t.includes('://')) return null;
    const at = t.lastIndexOf('@');
    if (at >= 0) t = t.slice(at + 1);
    let cut = t.length;
    for (const c of ['/', '?', '#', ':']) {
        const i = t.indexOf(c);
        if (i >= 0 && i < cut) cut = i;
    }
    const host = t.slice(0, cut).toLowerCase();
    const labels = host.split('.');
    if (labels.length < 2) return null;
    if (!labels.every((l) => LABEL.test(l))) return null;
    const tld = labels[labels.length - 1];
    if (!TOP_LEVEL_DOMAINS.has(tld) || !/[a-z]/.test(tld)) return null;
    return host;
}

/** Every URL and bare domain the text names, as written (a bare domain without its trailing punctuation). */
export function addressesIn(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(SCHEMED_URL)) out.push(m[0]);
    const withoutSchemed = text.replace(SCHEMED_URL, ' ');
    for (const token of withoutSchemed.split(/\s+/)) {
        if (bareHost(token) !== null) out.push(trim(token));
    }
    return out;
}

/** True when a source gives `address` verbatim (case-insensitively for its letters). */
export function sourceGivesAddress(address: string, sources: readonly string[]): boolean {
    const wanted = address.toLowerCase();
    return sources.some((s) => s.toLowerCase().includes(wanted));
}
