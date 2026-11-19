/**
 * An export is only ever an archive the import takes back (Phase 1.3). A
 * bible whose bundle the import would refuse by its byte bounds — past the
 * upload bound, or a file or the whole past the zip reader's inflated bounds
 * — is refused `EXPORT_TOO_LARGE`, as one past the element or relation bound
 * is, rather than handed over as a download that will not import.
 *
 * The real bounds are tens of MiB; this file shrinks them (and only them) so
 * a small bible crosses each one.
 */
// A plain copy of the module, whose bounds the test then sets: the export
// reads them at call time.
jest.mock('@/app-layer/schemas/bible-transfer', () => ({ ...jest.requireActual('@/app-layer/schemas/bible-transfer') }));

import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { createBook } from '@/app-layer/usecases/books';
import { exportBibleBundle } from '@/app-layer/usecases/bible-export';
import { AppError } from '@/lib/errors/types';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

type Transfer = typeof import('@/app-layer/schemas/bible-transfer');
const transfer = jest.requireMock<Transfer>('@/app-layer/schemas/bible-transfer');
const real = { uploadMax: transfer.BUNDLE_UPLOAD_MAX_BYTES, limits: transfer.BUNDLE_ZIP_LIMITS };
function setBounds(uploadMax: number, maxTotalBytes: number): void {
    Object.assign(transfer, { BUNDLE_UPLOAD_MAX_BYTES: uploadMax, BUNDLE_ZIP_LIMITS: { ...real.limits, maxTotalBytes } });
}

async function reasonOf(p: Promise<unknown>): Promise<unknown> {
    try {
        await p;
    } catch (err) {
        if (err instanceof AppError) return { status: err.status, ...(err.details as object) };
        throw err;
    }
    return 'exported';
}

it('refuses EXPORT_TOO_LARGE a bundle past the upload bound or the reader’s inflated total, and exports it within them', async () => {
    const ctx = workspaceCtx(await createAccount());
    const book = await createBook(ctx, { title: 'Large' });
    // Text that does not compress: the zip is about as large as its files.
    await createElement(ctx, book.id, { kind: 'THEME', name: 'Noise', fields: [{ key: 'stance', value: `<p>${randomBytes(30_000).toString('base64')}</p>` }] });

    expect(await reasonOf(exportBibleBundle(ctx, book.id))).toBe('exported');

    setBounds(20 * 1024, real.limits.maxTotalBytes);
    expect(await reasonOf(exportBibleBundle(ctx, book.id))).toMatchObject({ status: 400, reason: 'EXPORT_TOO_LARGE', what: 'bytes' });

    setBounds(real.uploadMax, 30 * 1024);
    expect(await reasonOf(exportBibleBundle(ctx, book.id))).toMatchObject({ status: 400, reason: 'EXPORT_TOO_LARGE', what: 'bytes' });
});
