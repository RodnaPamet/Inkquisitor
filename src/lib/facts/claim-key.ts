/**
 * A bible fact's claim key (Phase 4.1, D27): `claimParts` keyed with HMAC-SHA256
 * under the workspace's own subkey (`workspaceSubkey`), never a plain digest
 * of author text — the same claim in two workspaces keys differently, and the
 * key reveals nothing a dictionary could find. Server-only.
 */
import { createHmac } from 'node:crypto';
import { workspaceSubkey } from '@/lib/security/encryption';

const PURPOSE = 'inkquisitor-fact-claim/1';

export function claimKey(workspaceId: string, parts: readonly string[]): string {
    return createHmac('sha256', workspaceSubkey(PURPOSE, workspaceId)).update(JSON.stringify(parts).normalize('NFC'), 'utf8').digest('hex');
}
