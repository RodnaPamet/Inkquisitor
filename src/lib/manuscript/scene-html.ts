/**
 * A scene's text as the server stores and reads it (Phase 5.1).
 *
 *   storableSceneHtml   the editor's HTML, sanitised by the prose profile
 *                       (`sanitizeSceneHtml`), control characters stripped,
 *                       trimmed; a mention survives only when its id is one
 *                       the caller vouches for (an element of the scene's book)
 *   mentionCandidates   the `data-mention` ids a RAW text names, read with a
 *                       real parser (never a pattern), so the usecase can look
 *                       them up before the one sanitising pass
 *   mentionIdsOf        the mentions a STORED text holds (what the scene's
 *                       links are derived from on every text save)
 *   countSceneWords     the words of a stored text (`word-count.ts` over its
 *                       plain text: 3.4's HTML reader, a break between blocks)
 *   paragraphsAsHtml    an import's paragraphs as prose HTML, every character
 *                       escaped: imported text never becomes markup
 *
 * Server-only (htmlparser2, sanitize-html); the editor counts with
 * `countWords` over its own plain text.
 */
import { Parser } from 'htmlparser2';
import { sanitizeSceneHtml } from '@/lib/security/sanitize';
import { htmlToPlainText } from '@/lib/search/plain-text';
import { stripControlChars } from '@/lib/bible/text';
import { countWords } from './word-count';

/** Mentions read from one text at most (a scene's links are bounded far below this). */
export const MENTIONS_READ_MAX = 1_000;

/** The editor's HTML as stored: the prose profile, mentions only of ids `keepMention` accepts. */
export function storableSceneHtml(raw: string, keepMention: (elementId: string) => boolean): string {
    return stripControlChars(sanitizeSceneHtml(raw, keepMention)).trim();
}

function spanMentions(html: string): string[] {
    const ids: string[] = [];
    const parser = new Parser(
        {
            onopentag(name, attribs) {
                if (ids.length >= MENTIONS_READ_MAX || name !== 'span') return;
                const id = attribs['data-mention'];
                if (typeof id === 'string' && id.length > 0 && id.length <= 64 && !ids.includes(id)) ids.push(id);
            },
        },
        { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
    );
    parser.parseComplete(html);
    return ids;
}

/** The distinct `data-mention` ids a raw text names (unchecked: the caller looks each up). */
export function mentionCandidates(raw: string): string[] {
    return spanMentions(raw);
}

/** The distinct element ids a stored (sanitised) text mentions. */
export function mentionIdsOf(stored: string): string[] {
    return spanMentions(stored);
}

/** The words of a stored scene text. */
export function countSceneWords(stored: string): number {
    return stored === '' ? 0 : countWords(htmlToPlainText(stored));
}

/** A stored scene text as plain text (the diff, the research fit's excerpt). */
export function scenePlainText(stored: string): string {
    return stored === '' ? '' : htmlToPlainText(stored);
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Paragraphs of plain text as prose HTML (`<p>` each, every character escaped). */
export function paragraphsAsHtml(paragraphs: readonly string[]): string {
    let out = '';
    for (const p of paragraphs) if (p.trim() !== '') out += `<p>${escapeHtml(p)}</p>`;
    return out;
}
