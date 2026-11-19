/**
 * A session that was revoked, signed out, expired, or minted before the
 * user's `sessionVersion` was bumped is REFUSED, not flagged.
 *
 * The `jwt` callback in `src/auth.ts` throws this. NextAuth v4 treats a throw
 * from `jwt` as an invalid session: `getServerSession` returns `null`, so
 * every server gate built on it (`getWorkspaceCtx`, the workspace layout)
 * refuses the request, and `/api/auth/session` clears the cookie. A flag on
 * the token would be something every reader had to remember to check;
 * inflect-compliance shipped that once and no revocation signed anybody out.
 *
 * The edge middleware decodes the cookie without running the callback, so a
 * revoked browser passes the edge and is refused at the first server gate.
 *
 * Lifted from inflect-compliance's `src/lib/auth/session-revoked.ts` (see
 * docs/carve-manifest.md).
 */
export type SessionRevocationReason = 'session_revoked' | 'session_missing' | 'session_version_bumped';

export class SessionRevokedError extends Error {
    constructor(readonly reason: SessionRevocationReason) {
        super(`Session refused: ${reason}`);
        this.name = 'SessionRevokedError';
    }
}
