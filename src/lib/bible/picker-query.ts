/**
 * The relation picker's search text, as the element list takes it (issue #29
 * item 6). Client-safe.
 *
 * The list refuses a `q` longer than an element name may be (400), which the
 * picker showed as a failed search. No name can contain a longer text, so the
 * picker sends the text clamped to `ELEMENT_NAME_MAX` UTF-16 units — the unit
 * the server's bound counts — never splitting a surrogate pair (a lone
 * surrogate cannot be encoded into a URL). Blank is no search at all.
 */
import { ELEMENT_NAME_MAX } from './kinds';

export function pickerQuery(raw: string): string | undefined {
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    if (trimmed.length <= ELEMENT_NAME_MAX) return trimmed;
    let cut = trimmed.slice(0, ELEMENT_NAME_MAX);
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    return cut.trimEnd();
}
