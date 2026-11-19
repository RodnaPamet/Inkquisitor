/**
 * Every reason code a bible import can be refused with (Phase 1.3): the
 * request's own (`details.reason`) and each problem's of a refused bundle.
 * The import modal words each through `bible.transfer.reasons.<CODE>`
 * (`src/components/bible/import-messages.ts`). Client-safe.
 *
 * `tests/unit/bible/import-reasons.test.ts` fails when the server can name a
 * reason this list lacks, or the catalogue lacks a message for one listed.
 */
export const IMPORT_REASONS = [
    // The request
    'BUNDLE_REFUSED',
    'UPLOAD_INFECTED',
    'SCAN_UNAVAILABLE',
    'BODY_TOO_LARGE',
    'BODY_REQUIRED',
    'NOT_A_ZIP_UPLOAD',
    'SLUG_TAKEN',
    'KIND_CONFLICT',
    // The archive
    'NOT_A_ZIP',
    'ZIP64_UNSUPPORTED',
    'MULTI_DISK',
    'TOO_MANY_ENTRIES',
    'ENTRY_NAME_UNSAFE',
    'ENTRY_DUPLICATE',
    'ENTRY_ENCRYPTED',
    'ENTRY_METHOD_UNSUPPORTED',
    'ENTRY_TOO_LARGE',
    'ARCHIVE_TOO_LARGE',
    'ENTRY_RATIO',
    'ENTRY_CORRUPT',
    // A file
    'NOT_UTF8',
    'FRONTMATTER_MISSING',
    'YAML_INVALID',
    'YAML_ALIAS',
    'YAML_TAG',
    'MANIFEST_MISSING',
    'MANIFEST_INVALID',
    'FORMAT_VERSION_UNSUPPORTED',
    'BOOK_INVALID',
    'BOOK_FILE_MISSING',
    'UNEXPECTED_ENTRY',
    'TOO_MANY_ELEMENTS',
    'BUNDLE_EMPTY',
    'ELEMENT_INVALID',
    'UNKNOWN_KEY',
    'KIND_MISMATCH',
    'SLUG_MISMATCH',
    'DUPLICATE_SLUG',
    'RELATION_TARGET_UNKNOWN',
    'RELATION_TYPE_NOT_ALLOWED',
    'SELF_RELATION',
    // A value
    'EMPTY',
    'TOO_LONG',
    'CUSTOM_LABEL_REQUIRED',
    'CUSTOM_LABEL_NOT_ALLOWED',
    'UNKNOWN_FIELD',
    'DUPLICATE_FIELD',
    'NOT_A_STRING',
    'NOT_A_LIST',
    'TOO_MANY_ITEMS',
    'ITEM_NOT_A_STRING',
    'ITEM_TOO_LONG',
    'NOT_AN_OPTION',
    'NOT_A_WHOLE_NUMBER',
    'OUT_OF_RANGE',
] as const;
