/**
 * A PROMPT'S CONTENT HASH (Phase 2.H item 7; issue #36, item 6).
 *
 * An evaluation record says which prompt it graded by its VERSION, and a
 * version is a promise a person keeps: a change to a template's text with the
 * version left alone would leave every record still "current" while it graded
 * words the product no longer sends. So each record also carries the hash of
 * what the version names — everything a template sends that shapes the
 * answer, and the output schema the API is given — and the record checks
 * (and `tests/guards/evaluation-records-current.test.ts`, which CI runs)
 * recompute it. A changed prompt with no fresh record is refused by name:
 * `PROMPT_HASH_MISMATCH` / `PROMPT_CHANGED`, "re-run the evaluation".
 *
 * What is hashed: the id, version, purpose, tier, system prompt, task, output
 * budget, guard mode, and the JSON schema exactly as 2.1 sends it
 * (`jsonSchemaFor`). Not hashed: the cost budget, a statement about money
 * that changes no answer. The packs a call adds to its system prompt are
 * hashed on their own (each pack record pins its pack's content hash).
 * Canonical JSON (keys sorted), so a reordered literal is not a change.
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { canonicalJsonStringify } from '@/lib/audit/canonical-hash';
import { jsonSchemaFor } from './client';
import type { PromptTemplate } from './prompt';

const SHA256 = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

/** The content hash of one template and the output schema its calls send (`null`: a server-tool turn, no schema). */
export function promptContentHash(template: Readonly<PromptTemplate>, schema: z.ZodType | null): string {
    return SHA256(
        canonicalJsonStringify({
            id: template.id,
            version: template.version,
            purpose: template.purpose,
            tier: template.tier,
            system: template.system,
            task: template.task,
            maxOutputTokens: template.maxOutputTokens ?? null,
            guardMode: template.guardMode ?? null,
            schema: schema ? jsonSchemaFor(schema) : null,
        }),
    );
}

/** One hash over several steps' hashes, in the order given (a research run's three prompts). */
export function combinedPromptHash(hashes: readonly string[]): string {
    return SHA256(hashes.join('\n'));
}
