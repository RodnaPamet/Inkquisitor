/**
 * The draft reading's keyed hashes (Phase 5.3). Server-only. HMAC-SHA256 under the workspace's own subkey for each
 * purpose (`workspaceSubkey`), never a plain digest of author text.
 *
 *   textKey   the stored scene HTML a read read: an unchanged text is never read again, and a draft fact (or a link)
 *             read from another text is never placed in the editor at its old offsets
 *   claimKey  a draft fact's claim within its scene (4.1's `claimParts` with the scene as owner, keyed by 4.1's
 *             `claimKey`): one live draft fact per claim a scene, and one open mismatch a bible fact, scene and claim
 */
import { createHmac } from 'node:crypto';
import { claimKey } from '@/lib/facts/claim-key';
import { claimParts, type ClaimInput } from '@/lib/facts/dedupe';
import { workspaceSubkey } from '@/lib/security/encryption';

export function draftTextKey(workspaceId: string, storedHtml: string): string {
    return createHmac('sha256', workspaceSubkey('inkquisitor-draft-text/1', workspaceId)).update(storedHtml.normalize('NFC'), 'utf8').digest('hex');
}

export function draftClaimKey(workspaceId: string, sceneId: string, f: ClaimInput): string {
    return claimKey(workspaceId, claimParts({ kind: 'SCENE_TEXT', id: sceneId }, f));
}
