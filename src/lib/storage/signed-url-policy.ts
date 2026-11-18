/**
 * How long a presigned download URL lives.
 *
 * A signed URL is a BEARER credential: once minted it works for anyone holding
 * it, is replayable, is visible to intermediaries, and is outside our
 * revocation — quarantining the row it points at does not stop it. Its lifetime
 * is therefore the exposure window for those bytes, and the only lever we have
 * over it is this number.
 *
 * It lives in its own leaf module (no imports, so any layer can read it).
 * The S3 provider's `createSignedDownloadUrl` DEFAULTS to it and CAPS a
 * caller's `expiresIn` at it (`clampDownloadTtl`), so no caller mints a
 * longer-lived URL, by omission or on purpose
 * (tests/unit/platform/s3-storage.test.ts). Lifted from inflect-compliance's
 * `src/lib/storage/signed-url-policy.ts`, where the download route and the
 * evidence usecase read it; here the provider does, so the rule holds before
 * any route exists.
 *
 * Shortening this is always safe; lengthening it needs a reason written here.
 */
export const SIGNED_DOWNLOAD_URL_TTL_SECONDS = 300;

/**
 * How long a presigned UPLOAD target lives. An upload URL lets its holder
 * write one object at one key, and the upload is scanned before it is
 * served, so it may outlive a download URL; it is still a stated number, not
 * a fallback.
 */
export const SIGNED_UPLOAD_URL_TTL_SECONDS = 3600;

/** A download URL's lifetime: the policy's, or a caller's SHORTER positive one. */
export function clampDownloadTtl(requested?: number): number {
    if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return SIGNED_DOWNLOAD_URL_TTL_SECONDS;
    return Math.min(Math.floor(requested) || 1, SIGNED_DOWNLOAD_URL_TTL_SECONDS);
}
