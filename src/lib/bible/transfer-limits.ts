/**
 * The bible import's upload bounds (Phase 1.3), client-safe so the import
 * modal can refuse an over-large file before sending it. The server enforces
 * the same numbers (`src/app-layer/schemas/bible-transfer.ts`, the routes'
 * bounded body readers); the browser's check only saves a wasted upload.
 */

/** The largest bundle upload (the zip as sent): 20 MiB. */
export const BUNDLE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** The most text a concept note may hold, once sanitised: 50,000 characters. */
export const CONCEPT_NOTE_MAX = 50_000;
