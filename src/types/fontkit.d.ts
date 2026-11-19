/**
 * The part of fontkit (MIT, the font engine PDFKit embeds fonts with) that
 * src/lib/pdf/fonts.ts reads: open a font from bytes and ask which code
 * points it has a glyph for. fontkit ships no type declarations; this states
 * only what is used, so a call outside it fails `tsc` instead of passing as
 * `any`.
 */
declare module 'fontkit' {
    export interface Font {
        readonly postscriptName: string;
        readonly version: string;
        /** Every code point the font's cmap maps to a glyph. */
        readonly characterSet: number[];
        hasGlyphForCodePoint(codePoint: number): boolean;
    }

    /** One font; a collection (.ttc) is refused by the caller. */
    export function create(buffer: Uint8Array, postscriptName?: string): Font | { readonly fonts: Font[] };
}
