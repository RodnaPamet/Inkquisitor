/**
 * Every reason a bible import can be refused with has words (Phase 1.3).
 * The import modal words a refusal from its reason code through
 * `bible.transfer.reasons` (`IMPORT_REASONS`); a code the list lacks would
 * read as the generic message. This holds the list to the codes the server
 * can name — the zip reader's, the frontmatter reader's, a field value's,
 * and every literal reason the import usecase, its route and the body reader
 * write — and holds the catalogue to the list.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ZIP_REFUSAL_REASONS } from '@/lib/archive/zip';
import { FRONTMATTER_REFUSALS } from '@/lib/bible/bundle-format';
import type { FieldValueRefusal } from '@/lib/bible/field-values';
import { IMPORT_REASONS } from '@/lib/bible/import-reasons';
import { REPO_ROOT } from '../../helpers/repo-files';

/** Exhaustive over the type: a new field refusal fails to compile here until it is listed. */
const FIELD_REFUSALS: Record<FieldValueRefusal | 'UNKNOWN_FIELD' | 'DUPLICATE_FIELD', true> = {
    NOT_A_STRING: true,
    TOO_LONG: true,
    NOT_A_LIST: true,
    TOO_MANY_ITEMS: true,
    ITEM_NOT_A_STRING: true,
    ITEM_TOO_LONG: true,
    NOT_AN_OPTION: true,
    NOT_A_WHOLE_NUMBER: true,
    OUT_OF_RANGE: true,
    UNKNOWN_FIELD: true,
    DUPLICATE_FIELD: true,
};

/** The literal reasons written in a source file (`reason: 'X'`, and the problem objects' `reason: 'X'`). */
function literalReasons(file: string): string[] {
    const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    return [...src.matchAll(/reason: '([A-Z0-9_]+)'/g)].map((m) => m[1]);
}

describe('IMPORT_REASONS', () => {
    const listed = new Set<string>(IMPORT_REASONS);

    it('holds every reason the server can name', () => {
        const named = new Set<string>([
            ...ZIP_REFUSAL_REASONS,
            ...FRONTMATTER_REFUSALS,
            ...Object.keys(FIELD_REFUSALS),
            ...literalReasons('src/app-layer/usecases/bible-import.ts'),
            ...literalReasons('src/app/api/w/[workspaceSlug]/books/[bookId]/import/bundle/route.ts'),
            ...literalReasons('src/lib/http/bounded-body.ts'),
            // From bible-common: the column checks and a slug lost to a concurrent create.
            'EMPTY',
            'CUSTOM_LABEL_REQUIRED',
            'CUSTOM_LABEL_NOT_ALLOWED',
            'SLUG_TAKEN',
        ]);
        expect(literalReasons('src/app-layer/usecases/bible-import.ts').length).toBeGreaterThan(10);
        expect([...named].filter((r) => !listed.has(r)).sort()).toEqual([]);
    });

    it('has words for every reason, and a generic message for any other', () => {
        const messages = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'messages/en.json'), 'utf8')) as { bible: { transfer: { reasons: Record<string, string> } } };
        const words = messages.bible.transfer.reasons;
        expect(IMPORT_REASONS.filter((r) => typeof words[r] !== 'string' || words[r].trim() === '')).toEqual([]);
        expect(words.generic).toContain('{reason}');
        expect(Object.keys(words).filter((k) => k !== 'generic' && !listed.has(k))).toEqual([]);
    });
});
