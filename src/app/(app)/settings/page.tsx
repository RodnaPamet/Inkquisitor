import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/layout/PlaceholderPage';

export const metadata: Metadata = { title: 'Settings — Inkquisitor' };

/** Placeholder: the shell's Settings destination. Workspace settings arrive with 0.3. */
export default function SettingsPage() {
    return <PlaceholderPage page="settings" />;
}
