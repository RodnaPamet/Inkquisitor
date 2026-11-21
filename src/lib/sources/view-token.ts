/**
 * A FACTS VIEW'S TOKEN (Phase 4.0, D26: bulk confirm only what was shown).
 *
 * When the Facts page is read, the server signs exactly the facts it OFFERED
 * for bulk confirmation in that view — pending and unflagged — together with
 * the view (a book, or the series library), the reader and the time:
 * HMAC-SHA256 under the workspace's own subkey (`workspaceSubkey`), so a token
 * means nothing in another workspace. A bulk confirm sends the offered ids,
 * the time and the token back with the ids it confirms; the server recomputes
 * the HMAC, refuses a token older than `VIEW_TOKEN_MAX_AGE_MS`, and refuses
 * any id the view did not offer. The facts are then checked again in the
 * database (still pending, unflagged, in the view): a token never confirms an
 * unseen fact, and never a fact that changed since it was shown.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { workspaceSubkey } from '@/lib/security/encryption';
import { VIEW_TOKEN_MAX_AGE_MS } from './vocabulary';

export type FactsViewScope = { kind: 'book'; bookId: string } | { kind: 'series' };

export interface ViewTokenClaims {
    workspaceId: string;
    userId: string;
    view: FactsViewScope;
    offeredIds: readonly string[];
    issuedAt: number;
}

function payloadOf(c: ViewTokenClaims): string {
    const view = c.view.kind === 'book' ? `book:${c.view.bookId}` : 'series';
    return JSON.stringify(['facts-view/1', c.userId, view, c.issuedAt, [...c.offeredIds].sort()]);
}

export function signViewToken(c: ViewTokenClaims): string {
    return createHmac('sha256', workspaceSubkey('inkquisitor-source-facts-view/1', c.workspaceId)).update(payloadOf(c), 'utf8').digest('base64url');
}

export type ViewTokenVerdict = 'OK' | 'BAD_TOKEN' | 'EXPIRED';

export function verifyViewToken(c: ViewTokenClaims, token: string, now: number = Date.now()): ViewTokenVerdict {
    const expected = Buffer.from(signViewToken(c), 'utf8');
    const given = Buffer.from(token, 'utf8');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'BAD_TOKEN';
    if (!(c.issuedAt <= now + 60_000) || now - c.issuedAt > VIEW_TOKEN_MAX_AGE_MS) return 'EXPIRED';
    return 'OK';
}
