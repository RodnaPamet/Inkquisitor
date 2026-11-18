import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { PRODUCT_DESCRIPTION, PRODUCT_NAME } from '@/lib/product';
import './globals.css';

export const metadata: Metadata = {
    title: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
};

/**
 * Explicit viewport: Next does not emit a default viewport meta.
 * `maximumScale: 5` keeps pinch-zoom available, an accessibility
 * requirement.
 */
export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 5,
};

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en">
            <body className="min-h-screen bg-stone-50 text-stone-900 antialiased">{children}</body>
        </html>
    );
}
