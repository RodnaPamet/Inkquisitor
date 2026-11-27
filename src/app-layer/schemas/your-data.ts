/**
 * The author's data (Phase 5.H-a, D36): the request shapes of the full export and the whole-workspace deletion.
 * Strict: an unknown member is a 400. Both travel in a POST body, never a URL.
 *
 * THE PASSPHRASE is a secret the author chooses at download. It is bounded raw here and judged by
 * `passphraseRefusal` (`src/lib/export/passphrase.ts`); it is never stored, logged, audited, put in a job payload or
 * a URL, and Zod's issue messages carry no input (the error shape, `src/lib/errors/types.ts`).
 */
import { z } from 'zod';
import { PASSPHRASE_RAW_MAX_CHARS } from '@/lib/export/passphrase';

export const WorkspaceExportRequest = z.object({ passphrase: z.string().max(PASSPHRASE_RAW_MAX_CHARS) }).strict();
export type WorkspaceExportRequest = z.infer<typeof WorkspaceExportRequest>;

/** The workspace's name as the author typed it to confirm (bounded raw; compared trimmed), and whether their account goes too. */
export const WorkspaceDeletionRequest = z.object({ confirmName: z.string().min(1).max(400), deleteAccount: z.boolean().default(false) }).strict();
export type WorkspaceDeletionRequest = z.infer<typeof WorkspaceDeletionRequest>;
