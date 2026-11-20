/**
 * A string as a literal inside a `RegExp`: every pattern metacharacter is
 * escaped, never only the ones today's value happens to contain.
 */
export function escapeRegExp(text: string): string {
    return text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}
