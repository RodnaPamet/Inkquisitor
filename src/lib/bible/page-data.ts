/**
 * A bible page's data, read on the server (Phase 1.2): a book or element the
 * workspace does not hold (`NotFoundError` from the usecases, which treat
 * "another workspace's" and "no such row" alike) renders Next's 404 page.
 */
import { notFound } from 'next/navigation';
import { NotFoundError } from '@/lib/errors/types';

export async function orNotFound<T>(read: Promise<T>): Promise<T> {
    try {
        return await read;
    } catch (err) {
        if (err instanceof NotFoundError) notFound();
        throw err;
    }
}
