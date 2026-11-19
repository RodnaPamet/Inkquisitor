import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/layout/PlaceholderPage';

export const metadata: Metadata = { title: 'Books — Inkquisitor' };

/** Placeholder: the shell's Books destination. The bible UI arrives in Phase 1. */
export default function BooksPage() {
    return <PlaceholderPage page="books" />;
}
