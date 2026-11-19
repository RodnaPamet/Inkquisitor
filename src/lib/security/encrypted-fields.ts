/**
 * THE ENCRYPTED-FIELDS MANIFEST — which columns are encrypted at rest.
 *
 * The Prisma extension in `src/lib/db/encryption-middleware.ts` encrypts
 * every listed field on write (a `v2:` envelope under the workspace's data
 * key inside `runInWorkspaceContext`) and decrypts it on read. Callers never
 * see ciphertext and never call the primitives themselves.
 *
 * THE BIBLE'S AUTHOR TEXT (Phase 1.1, roadmap rule 4: author text is
 * encrypted at rest): a book's logline, an element's summary, every field
 * value, a relation's note, and a version's snapshot (the element and its
 * fields, serialised to one JSON string, `src/lib/bible/snapshot.ts`) and
 * change summary. Users, workspaces, memberships and the audit trail carry
 * identifiers, not content. Book titles, element names, slugs and custom
 * labels stay readable on purpose: lists sort by them and the slug is a
 * unique key (docs/implementation-notes/2026-11-19-1.1-bible-model.md).
 *
 * Every listed field is ciphertext at rest and reads back in its own
 * workspace (`tests/integration/bible-encryption.test.ts`); the extension's
 * behaviour is also proved against a test manifest
 * (`tests/unit/security/encryption-extension.test.ts`,
 * `tests/integration/field-encryption.test.ts`), which is why it takes the
 * manifest as a parameter. Every listed field's write path sanitises it
 * first (`tests/guards/encrypted-field-sanitiser-coverage.test.ts`).
 *
 * Adding a field: list it here, in the same change as the column. A field is
 * a `String`/`String?` column; anything else passes through untouched.
 *
 * Adapted from inflect-compliance's `src/lib/security/encrypted-fields.ts`
 * (see docs/carve-manifest.md): the compliance entries are gone, and the
 * lookup helpers are compiled from a manifest value rather than module
 * constants, so a test manifest gets the same behaviour as the real one.
 */

/** Model name → the string fields encrypted at rest. */
export type EncryptedFieldManifest = Readonly<Record<string, readonly string[]>>;

export const ENCRYPTED_FIELDS: EncryptedFieldManifest = Object.freeze({
    Book: Object.freeze(['logline']),
    BibleElement: Object.freeze(['summary']),
    BibleField: Object.freeze(['value']),
    BibleRelation: Object.freeze(['note']),
    BibleEntryVersion: Object.freeze(['snapshot', 'changeSummary']),
});

/** The lookups the extension runs per operation, compiled once per manifest. */
export interface CompiledManifest {
    fieldsOf(model: string): readonly string[] | undefined;
    isEncryptedModel(model: string): boolean;
    isEmpty: boolean;
}

export function compileManifest(manifest: EncryptedFieldManifest): CompiledManifest {
    // A field is encrypted only on the model that lists it; there is no
    // model-less "any field of this name" lookup (a nested write is resolved
    // to its model through the schema's relations instead).
    const fieldCount = Object.values(manifest).reduce((n, fields) => n + fields.length, 0);
    return {
        fieldsOf: (model) => (Object.prototype.hasOwnProperty.call(manifest, model) ? manifest[model] : undefined),
        isEncryptedModel: (model) => Object.prototype.hasOwnProperty.call(manifest, model) && manifest[model].length > 0,
        isEmpty: fieldCount === 0,
    };
}
