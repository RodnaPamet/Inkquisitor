/**
 * The full export's passphrase rule (Phase 5.H-a, D36). Client-safe: the download dialog judges a passphrase with
 * the same function the server does, so the author is told before they send it.
 *
 * At least `PASSPHRASE_MIN_CHARS` characters (code points, so an accented or non-Latin passphrase counts as written),
 * at most `PASSPHRASE_MAX_CHARS`, and not a run of a few characters repeated (at least `PASSPHRASE_MIN_DISTINCT`
 * different ones). The archive is AES-256 (WinZip AE-2), whose key is derived from the passphrase by PBKDF2-SHA1 with
 * 1,000 iterations — the format's own, which no reader lets us raise — so the passphrase's length is what protects it.
 */

export const PASSPHRASE_MIN_CHARS = 12;
export const PASSPHRASE_MAX_CHARS = 256;
/** Refused unread past this (a length check, never a parse). */
export const PASSPHRASE_RAW_MAX_CHARS = PASSPHRASE_MAX_CHARS * 4;
export const PASSPHRASE_MIN_DISTINCT = 5;

export type PassphraseRefusal = 'PASSPHRASE_TOO_SHORT' | 'PASSPHRASE_TOO_LONG' | 'PASSPHRASE_TOO_SIMPLE';

/** Why a passphrase is refused, or null when it is accepted. */
export function passphraseRefusal(passphrase: string): PassphraseRefusal | null {
    const chars = [...passphrase];
    if (chars.length < PASSPHRASE_MIN_CHARS) return 'PASSPHRASE_TOO_SHORT';
    if (chars.length > PASSPHRASE_MAX_CHARS) return 'PASSPHRASE_TOO_LONG';
    if (new Set(chars).size < PASSPHRASE_MIN_DISTINCT) return 'PASSPHRASE_TOO_SIMPLE';
    return null;
}
