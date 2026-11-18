/**
 * `Content-Disposition` filenames — one sanitiser, one header builder.
 *
 * Interpolating a user-supplied filename into `attachment; filename="…"`
 * lets a `"` close the quoted string early (injecting header parameters) and
 * a CR/LF end the header line (response splitting). Every download header is
 * built here, so the quoting and the sanitising cannot drift apart.
 *
 * Lifted from inflect-compliance's `src/lib/http/content-disposition.ts`.
 */

/** Fallback when a name sanitises down to nothing. */
const FALLBACK = 'download';

/**
 * Make a filename safe to interpolate into a quoted `Content-Disposition`
 * parameter.
 *
 * Strips every character outside printable ASCII — which covers CR, LF, NUL
 * and the rest of the C0 range in one pass — then neutralises the double
 * quote. Both steps are load-bearing; neither alone is sufficient.
 */
export function sanitizeContentDispositionFilename(name: string | null | undefined): string {
    const cleaned = (name ?? '')
        // Non-printable-ASCII → `_`. This is the CR/LF defence: response
        // splitting needs a raw newline, and there is no newline left.
        .replace(/[^\x20-\x7E]/g, '_')
        // The quote that would end the quoted-string. `'` is a legal filename
        // character on every platform we serve, so this loses nothing.
        .replace(/"/g, "'")
        // A leading/trailing space or dot round-trips badly through Windows
        // and through some proxies; trim rather than surprise the user.
        .replace(/^[\s.]+|[\s.]+$/g, '');

    return cleaned || FALLBACK;
}

/**
 * Build the whole header value. Prefer this over hand-interpolating, so the
 * quoting and the sanitising cannot drift apart at a call site.
 *
 * @param disposition `attachment` (default) forces a download; `inline` lets
 *   the browser render it. Never derive this from user input — an `inline`
 *   HTML file is stored XSS on our origin.
 */
export function contentDispositionHeader(
    name: string | null | undefined,
    disposition: 'attachment' | 'inline' = 'attachment',
): string {
    return `${disposition}; filename="${sanitizeContentDispositionFilename(name)}"`;
}
