/**
 * What a book's prose checks run under (Phase 5.2, D34): its compiled style
 * sheet (`pickStyleSheetElement` → `compileStyleSheet`), its inclusive-language
 * switch, and its character names. Read by the job (`prose-check-run.ts`) and
 * by the reads (`prose-checks.ts`), so a read's status is judged against the
 * same configuration a check stores. Loads no rule code: the route handlers
 * that import it carry no retext or write-good.
 */
import { ProseCheckRepository } from '@/app-layer/repositories/prose-check.repository';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { decodeFieldValue, type FieldValue } from '@/lib/bible/field-values';
import { compileStyleSheet, EMPTY_STYLE_SHEET, pickStyleSheetElement, type CompiledStyleSheet } from '@/lib/prose-checks/style-sheet';
import { PROSE_CHARACTER_NAMES_MAX } from '@/lib/prose-checks/vocabulary';

/** Style elements a book is read for (its sheet is one of them). */
const STYLE_ELEMENTS_READ = 50;

export interface BookCheckSetup {
    sheet: CompiledStyleSheet;
    /** The sheet element's name (shown in the settings), or null. */
    styleName: string | null;
    alexEnabled: boolean;
    characters: Array<{ id: string; name: string }>;
}

export async function readBookCheckSetup(db: PrismaTx, workspaceId: string, bookId: string): Promise<BookCheckSetup> {
    const styles = await ProseCheckRepository.styleElements(db, workspaceId, bookId, STYLE_ELEMENTS_READ);
    const rows = styles.map((e) => {
        const fields: Record<string, FieldValue> = {};
        for (const f of e.fields) {
            try {
                fields[f.key] = decodeFieldValue(f.value);
            } catch {
                // A value that does not decode is left out (the sheet reads it as unset).
            }
        }
        return { id: e.id, name: e.name, createdAt: e.createdAt, fields };
    });
    const picked = pickStyleSheetElement(rows);
    const settings = await ProseCheckRepository.findSettings(db, workspaceId, bookId);
    const characters = await ProseCheckRepository.characterNames(db, workspaceId, bookId, PROSE_CHARACTER_NAMES_MAX);
    return {
        sheet: picked ? compileStyleSheet(picked.id, picked.fields) : EMPTY_STYLE_SHEET,
        styleName: picked?.name ?? null,
        alexEnabled: settings?.alexEnabled ?? false,
        characters,
    };
}
