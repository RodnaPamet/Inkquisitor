/**
 * The bible's import and export routes (Phase 1.3), called as Next calls
 * them, with the session as the one seam (`auth()`), as in the route
 * authorization suite:
 *
 *   GET  …/export/bundle     a zip download, named for the book, never cached
 *   GET  …/export/pdf        a PDF download
 *   POST …/import/bundle     the zip as the body; a body past the bound is a
 *                            413 refused on its declared length, unread; a
 *                            body that is not labelled a zip is refused
 *   POST …/import/concept-note   JSON; 201 for a new element, 200 after
 *
 * The scanner is ClamAV in production; here AV_SCAN_MODE=disabled, the
 * development setting with no clamd, under which the scan reports CLEAN.
 * Signed out, stranger and READER are tests/integration/api-route-authorization.test.ts.
 */
const session: { userId: string | null } = { userId: null };
jest.mock('@/auth', () => ({
    auth: async () => (session.userId ? { user: { id: session.userId, email: 'x@example.test', name: null }, expires: '' } : null),
}));

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { readZip } from '@/lib/archive/zip';
import { BUNDLE_UPLOAD_MAX_BYTES, BUNDLE_ZIP_LIMITS } from '@/app-layer/schemas/bible-transfer';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { createBook } from '@/app-layer/usecases/books';
import { GET as exportBundle } from '@/app/api/w/[workspaceSlug]/books/[bookId]/export/bundle/route';
import { GET as exportPdf } from '@/app/api/w/[workspaceSlug]/books/[bookId]/export/pdf/route';
import { POST as importBundle } from '@/app/api/w/[workspaceSlug]/books/[bookId]/import/bundle/route';
import { POST as importNote } from '@/app/api/w/[workspaceSlug]/books/[bookId]/import/concept-note/route';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

const scanMode = process.env.AV_SCAN_MODE;
beforeAll(() => {
    process.env.AV_SCAN_MODE = 'disabled';
});
afterAll(async () => {
    if (scanMode === undefined) delete process.env.AV_SCAN_MODE;
    else process.env.AV_SCAN_MODE = scanMode;
    await prisma.$disconnect();
});

let owner: Awaited<ReturnType<typeof createAccount>>;
let bookId: string;

beforeAll(async () => {
    owner = await createAccount();
    session.userId = owner.userId;
    const ctx = workspaceCtx(owner);
    bookId = (await createBook(ctx, { title: 'Routes & Roads' })).id;
    await createElement(ctx, bookId, { kind: 'THEME', name: 'Debt', fields: [{ key: 'subject', value: 'Debts compound' }] });
});

function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: BodyInit | null } = {}): NextRequest {
    return new NextRequest(`http://localhost/api/w/${owner.workspaceSlug}/books/${bookId}${path}`, {
        method: init.method ?? 'GET',
        headers: { 'x-forwarded-for': '198.51.100.31', ...init.headers },
        body: init.body ?? undefined,
        // Required by undici for a streamed body.
        ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
    });
}

const params = () => ({ params: Promise.resolve({ workspaceSlug: owner.workspaceSlug, bookId }) });

describe('export', () => {
    it('downloads the bundle as a zip named for the book, never cached', async () => {
        const res = await exportBundle(request('/export/bundle'), params());
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/zip');
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="routes-roads-bible.zip"');
        expect(res.headers.get('cache-control')).toBe('no-store');
        const files = readZip(new Uint8Array(await res.arrayBuffer()), BUNDLE_ZIP_LIMITS);
        expect([...files.keys()]).toEqual(['book.md', 'manifest.json', 'theme/_index.md', 'theme/debt.md']);
    });

    it('downloads the PDF', async () => {
        const res = await exportPdf(request('/export/pdf'), params());
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/pdf');
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="routes-roads-bible.pdf"');
        expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
});

describe('import', () => {
    it('imports a bundle sent as the body, and answers the report', async () => {
        const zip = new Uint8Array(await (await exportBundle(request('/export/bundle'), params())).arrayBuffer());
        const res = await importBundle(request('/import/bundle', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip }), params());
        expect(res.status).toBe(200);
        const { report } = (await res.json()) as { report: { elements: Record<string, number>; versionsWritten: number } };
        expect(report.elements).toEqual({ created: 0, updated: 0, unchanged: 1 });
        expect(report.versionsWritten).toBe(0);
    });

    it('refuses a body larger than the bound on its declared length, without reading it', async () => {
        let pulled = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled++;
                controller.enqueue(new Uint8Array(64 * 1024));
            },
        });
        const res = await importBundle(
            request('/import/bundle', { method: 'POST', headers: { 'content-type': 'application/zip', 'content-length': String(BUNDLE_UPLOAD_MAX_BYTES + 1) }, body }),
            params(),
        );
        expect(res.status).toBe(413);
        expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('BODY_TOO_LARGE');
        expect(pulled).toBeLessThanOrEqual(1);
    });

    it('refuses a body that is not labelled a zip', async () => {
        const res = await importBundle(request('/import/bundle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), params());
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('NOT_A_ZIP_UPLOAD');
    });

    it('stores a concept note: 201 for the new element, 200 when it is already there', async () => {
        const body = JSON.stringify({ text: 'A pitch\n\nIn two paragraphs.' });
        const first = await importNote(request('/import/concept-note', { method: 'POST', headers: { 'content-type': 'application/json' }, body }), params());
        expect(first.status).toBe(201);
        const second = await importNote(request('/import/concept-note', { method: 'POST', headers: { 'content-type': 'application/json' }, body }), params());
        expect(second.status).toBe(200);
        expect(((await second.json()) as { report: { outcome: string } }).report.outcome).toBe('unchanged');
    });
});
