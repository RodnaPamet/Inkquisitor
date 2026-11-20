/**
 * Canvas export's pure halves (Phase 3.1); adapted from inflect-compliance's
 * `tldraw-canvas-export.test.ts` (docs/carve-manifest.md). The editor is a
 * stub: what reaches the download is asserted, nothing is rasterised.
 */
import { EmptyCanvasExportError, exportCanvasAsSvg, injectBackgroundRect, safeFilename } from '@/lib/canvas/canvas-export';
import type { Editor } from 'tldraw';

it('a background rect goes in as the SVG’s first child, and only a hex colour is admitted', () => {
    expect(injectBackgroundRect('<?xml?><svg width="1"><g/></svg>', '#112233')).toBe('<?xml?><svg width="1"><rect x="0" y="0" width="100%" height="100%" fill="#112233"/><g/></svg>');
    expect(() => injectBackgroundRect('<svg></svg>', 'red" onload="x')).toThrow('Not a hex colour');
    expect(() => injectBackgroundRect('<div></div>', '#fff')).toThrow('Not an SVG');
});

it('a filename is reduced to what a filesystem takes, with a fallback for nothing', () => {
    expect(safeFilename('The Long Night — Plot board', 'png')).toBe('the-long-night-plot-board.png');
    expect(safeFilename('***', 'svg')).toBe('story-map.svg');
    // The cut at 60 characters never leaves a trailing hyphen, nor a leading one.
    expect(safeFilename(`${'a'.repeat(59)} b`, 'svg')).toBe(`${'a'.repeat(59)}.svg`);
    expect(safeFilename(`  ${'b'.repeat(70)}`, 'svg')).toMatch(/^b{1,60}\.svg$/);
});

it('exports the current page as an SVG download with the background in it', async () => {
    const editor = {
        getCurrentPageShapes: () => [{ id: 'shape:a' }],
        getSvgString: jest.fn().mockResolvedValue({ svg: '<svg><g/></svg>', width: 1, height: 1 }),
    } as unknown as Editor;
    const downloadImpl = jest.fn();
    const url = await exportCanvasAsSvg({ editor, fileStem: 'Book Map', downloadImpl });
    expect(downloadImpl).toHaveBeenCalledWith(url, 'book-map.svg');
    expect(decodeURIComponent(url)).toMatch(/^data:image\/svg\+xml;utf8,<svg><rect [^>]*fill="#[0-9a-fA-F]+"\/><g\/><\/svg>$/);
    expect((editor.getSvgString as jest.Mock).mock.calls[0][1]).toEqual({ background: false, padding: 24 });
});

it('an empty page cannot be exported', async () => {
    const editor = { getCurrentPageShapes: () => [] } as unknown as Editor;
    await expect(exportCanvasAsSvg({ editor, fileStem: 'x', downloadImpl: jest.fn() })).rejects.toBeInstanceOf(EmptyCanvasExportError);
});
