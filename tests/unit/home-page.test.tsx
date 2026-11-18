import { renderToStaticMarkup } from 'react-dom/server';
import HomePage from '@/app/page';
import { metadata } from '@/app/layout';
import { PRODUCT_DESCRIPTION, PRODUCT_NAME } from '@/lib/product';

describe('home page', () => {
    const html = renderToStaticMarkup(<HomePage />);

    it('renders the product name as the page heading', () => {
        expect(html).toMatch(/<h1[^>]*>Inkquisitor<\/h1>/);
        expect(PRODUCT_NAME).toBe('Inkquisitor');
    });

    it('renders the one-line description', () => {
        expect(PRODUCT_DESCRIPTION.length).toBeGreaterThan(0);
        // React escapes text content; the description carries no characters
        // that need escaping, so it appears verbatim.
        expect(html).toContain(`>${PRODUCT_DESCRIPTION}</p>`);
    });

    it('styles the heading with Tailwind utilities', () => {
        expect(html).toMatch(/<h1 class="[^"]*\btext-5xl\b[^"]*\bfont-bold\b/);
    });

    it('names the product in the document metadata', () => {
        expect(metadata.title).toBe(PRODUCT_NAME);
        expect(metadata.description).toBe(PRODUCT_DESCRIPTION);
    });
});
