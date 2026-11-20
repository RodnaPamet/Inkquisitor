/**
 * Canvas export, on tldraw: the current page as PNG or SVG.
 *
 * Carved from inflect-compliance's `src/lib/processes/tldraw-canvas-export.ts`
 * and `canvas-export-shared.ts` (docs/carve-manifest.md), without the
 * server-backed PDF and evidence exports and the clipboard copy.
 *
 * tldraw renders the bytes itself (`editor.toImage`, `editor.getSvgString`),
 * with `background: false`: its own background is its theme's, and an
 * exported map should carry the product's page colour. That colour is the
 * `--bg-page` token as the document resolves it NOW (so a dark-theme author
 * exports a dark map), applied as a `<rect>` in the SVG and composited under
 * the PNG. Nothing leaves the browser: the export is a download.
 *
 * The current page only (a map is one page), so a shape parked elsewhere
 * cannot leak into an export.
 */
import type { Editor } from 'tldraw';

/** Padding, in page units, around the exported content. */
export const EXPORT_PADDING = 24;
/** Used when the token cannot be read (no document: a test, a server render). */
const FALLBACK_BACKGROUND = '#ffffff';
const HEX_COLOUR = /^#[0-9a-fA-F]{3,8}$/;

export interface CanvasExportOptions {
    editor: Editor;
    /** The download's name stem. */
    fileStem: string;
    /** Seam for the PNG background composite (a test has no 2D context). */
    compositeImpl?: (blob: Blob, background: string) => Promise<Blob>;
    /** Seam for the download (a test asserts what would be saved). */
    downloadImpl?: (dataUrl: string, filename: string) => void;
}

/** A map with nothing on it cannot be exported to an image. */
export class EmptyCanvasExportError extends Error {
    constructor() {
        super('There is nothing on this canvas to export.');
        this.name = 'EmptyCanvasExportError';
    }
}

/** A name reduced to what a filesystem accepts; `story-map` when nothing is left. */
export function safeFilename(stem: string, ext: string): string {
    // Runs collapse to ONE hyphen first, so the trims below take a single
    // character each (no `-+$`, which backtracks on a long run), and they run
    // AFTER the cut, which can otherwise leave the name ending in a hyphen.
    const cleaned =
        stem
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .slice(0, 60)
            .replace(/^-/, '')
            .replace(/-$/, '') || 'story-map';
    return `${cleaned}.${ext}`;
}

/** The page colour behind an exported map: the `--bg-page` token, resolved. */
export function resolveBackground(): string {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return FALLBACK_BACKGROUND;
    const value = getComputedStyle(document.documentElement).getPropertyValue('--bg-page').trim();
    return HEX_COLOUR.test(value) ? value : FALLBACK_BACKGROUND;
}

/** Insert a full-bleed background rect as the first child of an SVG. */
export function injectBackgroundRect(svg: string, background: string): string {
    if (!HEX_COLOUR.test(background)) throw new Error('Not a hex colour');
    const svgAt = svg.indexOf('<svg');
    if (svgAt === -1) throw new Error('Not an SVG document');
    const openTagEnd = svg.indexOf('>', svgAt);
    if (openTagEnd === -1) throw new Error('Malformed SVG: unterminated <svg> tag');
    const rect = `<rect x="0" y="0" width="100%" height="100%" fill="${background}"/>`;
    return svg.slice(0, openTagEnd + 1) + rect + svg.slice(openTagEnd + 1);
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read the exported image')));
        reader.onerror = () => reject(reader.error ?? new Error('Could not read the exported image'));
        reader.readAsDataURL(blob);
    });
}

async function compositeOntoBackground(blob: Blob, background: string): Promise<Blob> {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get a 2D context for the export');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('Could not encode the export'))), 'image/png');
    });
}

function shapesToExport(editor: Editor) {
    const shapes = editor.getCurrentPageShapes();
    if (shapes.length === 0) throw new EmptyCanvasExportError();
    return shapes;
}

/** The current page as an SVG download; returns the data URL. */
export async function exportCanvasAsSvg(opts: CanvasExportOptions): Promise<string> {
    const result = await opts.editor.getSvgString(shapesToExport(opts.editor), { background: false, padding: EXPORT_PADDING });
    if (!result) throw new EmptyCanvasExportError();
    const svg = injectBackgroundRect(result.svg, resolveBackground());
    const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    (opts.downloadImpl ?? downloadDataUrl)(dataUrl, safeFilename(opts.fileStem, 'svg'));
    return dataUrl;
}

/** The current page as a PNG download; returns the data URL. */
export async function exportCanvasAsPng(opts: CanvasExportOptions): Promise<string> {
    const { blob } = await opts.editor.toImage(shapesToExport(opts.editor), { format: 'png', background: false, padding: EXPORT_PADDING });
    const composite = await (opts.compositeImpl ?? compositeOntoBackground)(blob, resolveBackground());
    const dataUrl = await blobToDataUrl(composite);
    (opts.downloadImpl ?? downloadDataUrl)(dataUrl, safeFilename(opts.fileStem, 'png'));
    return dataUrl;
}
