/**
 * Word search's request shape (Phase 3.4). Strict: an unknown member is a
 * 400. The query travels in a POST body, never a URL (the 3.4 note: a query
 * string reaches Next's own request span and a reverse proxy's access log).
 *
 * The member is bounded raw (`SEARCH_QUERY_RAW_MAX_CHARS`) so a huge value is
 * refused by a length check; the trimmed query's own bound, and the word and
 * phrase bounds, are the parser's (`parseQuery`), which names the refusal.
 */
import { z } from 'zod';
import { SEARCH_QUERY_RAW_MAX_CHARS } from '@/lib/search/vocabulary';

export const BookSearchRequest = z.object({ q: z.string().max(SEARCH_QUERY_RAW_MAX_CHARS) }).strict();
export type BookSearchRequest = z.infer<typeof BookSearchRequest>;
