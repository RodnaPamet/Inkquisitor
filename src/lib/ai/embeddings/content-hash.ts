/**
 * The content hash a vector is filed with: a KEYED hash of the text it was
 * computed from.
 *
 * The store compares hashes and never reads text: an upsert whose key already
 * holds the same hash writes nothing (`unchanged`), and a caller learns a
 * source's vectors are stale when its text's hash moved. Inflect-compliance
 * files a plain SHA-256 of the chunk text; Inkquisitor does not, because the
 * text is an author's (roadmap rule 4: private everywhere but the model call),
 * much of it short — a one-word answer, a character's eye colour — and a
 * plain digest of a short text is recovered by hashing guesses. HMAC-SHA256
 * under a purpose-labelled subkey of the deployment's master key
 * (`deriveSubkey`) is as stable for idempotence and recovers nothing without
 * the key.
 *
 * The text is NFC-normalised first, so two spellings of one string that the
 * author cannot tell apart are one hash.
 *
 * PER WORKSPACE (Phase 2.H, issue #32 item 2): the key is the purpose's
 * subkey for the vector's own workspace (`workspaceSubkey`), so equal text in
 * two workspaces files different hashes. The purpose label moved to `/2` with
 * it: a vector filed under `/1` reads as stale and is rewritten by its next
 * upsert (the hash is idempotence, never a lookup), and a rebuild refiles
 * every vector.
 *
 * @module lib/ai/embeddings/content-hash
 */
import { createHmac } from 'node:crypto';

import { workspaceSubkey } from '@/lib/security/encryption';

const PURPOSE = 'inkquisitor-vector-content-hash/2';

/** 64 lower-case hex characters: the store's and the table's `contentHash` format. */
export function vectorContentHash(workspaceId: string, text: string): string {
    return createHmac('sha256', workspaceSubkey(PURPOSE, workspaceId)).update(text.normalize('NFC'), 'utf8').digest('hex');
}
