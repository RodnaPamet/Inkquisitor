/**
 * The JSON body of a request, or a 400. `req.json()` throws a bare
 * SyntaxError on a malformed body, which the error handler cannot tell from
 * a server fault (500); this answers it as the caller's mistake instead. The
 * parser's message (which can quote the body) is not passed on.
 *
 * `optional`: an empty body reads as `{}` (an action whose every input is optional).
 */
import type { NextRequest } from 'next/server';
import { ValidationError } from '@/lib/errors/types';

export async function readJsonBody(req: NextRequest, options: { optional?: boolean } = {}): Promise<unknown> {
    const text = await req.text();
    if (text.trim() === '') {
        if (options.optional) return {};
        throw new ValidationError('A JSON body is required.', { reason: 'BODY_REQUIRED' });
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new ValidationError('The body is not valid JSON.', { reason: 'BODY_NOT_JSON' });
    }
}
