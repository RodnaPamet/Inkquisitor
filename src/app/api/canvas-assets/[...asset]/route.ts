/**
 * GET /api/canvas-assets/<version>/<path> — one of tldraw's own static files (a font, the icon
 * sprite, an embed icon, the English translation) from the installed `@tldraw/assets` package (Phase 3.1).
 *
 * PUBLIC: these are a published library's files, the same for every visitor, and carry no data.
 * The story canvas loads them from here rather than tldraw's CDN, which the content-security
 * policy refuses (`src/lib/canvas/tldraw-assets.ts`). Only the version the build names and the
 * paths `CANVAS_ASSET_PATH` admits are served, from inside the package's directory; anything
 * else is a 404 before the filesystem is asked. Cached for good: a new release is a new URL.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { CANVAS_ASSET_PATH, TLDRAW_ASSETS_VERSION } from '@/lib/canvas/tldraw-assets';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json',
};

const notFound = () => new NextResponse(null, { status: 404 });

export const GET = async (_req: NextRequest, { params }: { params: Promise<{ asset: string[] }> }) => {
    const [version, ...rest] = (await params).asset;
    const relative = rest.join('/');
    if (version !== TLDRAW_ASSETS_VERSION || !CANVAS_ASSET_PATH.test(relative)) return notFound();
    const root = path.join(process.cwd(), 'node_modules', '@tldraw', 'assets');
    const file = path.resolve(root, relative);
    // Belt and braces: the pattern admits no `..`, and the resolved file must stay in the package.
    if (!file.startsWith(root + path.sep)) return notFound();
    let bytes: Buffer;
    try {
        bytes = await readFile(file);
    } catch {
        return notFound();
    }
    return new NextResponse(new Uint8Array(bytes), {
        status: 200,
        headers: {
            'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000, immutable',
        },
    });
};
