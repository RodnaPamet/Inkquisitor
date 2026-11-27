/**
 * AN IMPORT PREVIEW'S TOKEN (Phase 5.1, D33: the author confirms the split).
 *
 * The file is never stored: the preview reads it, shows the proposed split
 * and forgets it; the confirm sends the same file again with the plan the
 * author chose. The token ties the two together — HMAC-SHA256, under the
 * workspace's own subkey (`workspaceSubkey`), over the reader, the book, the
 * file's SHA-256 and the time — so the confirm is refused when it is a
 * different file (`IMPORT_FILE_CHANGED`) or the preview is older than
 * `IMPORT_TOKEN_MAX_AGE_MS` (`IMPORT_PREVIEW_EXPIRED`): what is written is
 * the split of the very file the author looked at.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { workspaceSubkey } from '@/lib/security/encryption';
import { IMPORT_TOKEN_MAX_AGE_MS } from './vocabulary';

export interface ImportTokenClaims {
    workspaceId: string;
    userId: string;
    bookId: string;
    /** The file's SHA-256, hex. */
    fileSha256: string;
    issuedAt: number;
}

export function fileSha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function payloadOf(c: ImportTokenClaims): string {
    return JSON.stringify(['manuscript-import/1', c.userId, c.bookId, c.fileSha256, c.issuedAt]);
}

export function signImportToken(c: ImportTokenClaims): string {
    return createHmac('sha256', workspaceSubkey('inkquisitor-manuscript-import/1', c.workspaceId)).update(payloadOf(c), 'utf8').digest('base64url');
}

export type ImportTokenVerdict = 'OK' | 'BAD_TOKEN' | 'EXPIRED';

export function verifyImportToken(c: ImportTokenClaims, token: string, now: number = Date.now()): ImportTokenVerdict {
    const expected = Buffer.from(signImportToken(c), 'utf8');
    const given = Buffer.from(token, 'utf8');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'BAD_TOKEN';
    if (!(c.issuedAt <= now + 60_000) || now - c.issuedAt > IMPORT_TOKEN_MAX_AGE_MS) return 'EXPIRED';
    return 'OK';
}
