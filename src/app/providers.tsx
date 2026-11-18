'use client';

/**
 * App-wide client providers, mounted once by the root layout.
 *
 * Adapted from inflect-compliance's `src/app/providers.tsx` (see
 * docs/carve-manifest.md). Kept, in inflect's order: the keyboard-shortcut
 * registry (one window keydown listener for every registered shortcut), the
 * command-palette provider inside it (it registers `mod+k` on that registry),
 * the theme and tooltip providers, the palette surface, the shortcut-help
 * overlay and the toast host. Left behind: SWR and its session-expiry seam,
 * the assistant, form telemetry and the Zod JIT switch — none of those
 * subsystems exists in Inkquisitor yet.
 *
 * `NextIntlClientProvider` wraps this component in the root layout, never the
 * other way round: the palette, the help overlay and the toasts call
 * `useTranslations()`, and would render with no intl context inside it.
 */

import { Toaster } from 'sonner';
import { ThemeProvider, useTheme } from '@/components/theme/ThemeProvider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CommandPalette, CommandPaletteProvider } from '@/components/command-palette';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { ShortcutHelpOverlay } from '@/components/app-shell/shortcut-help-overlay';

/** The toast host, in the current theme (inflect pinned it to dark). */
function ThemedToaster() {
    const { theme } = useTheme();
    return <Toaster theme={theme} position="top-right" richColors closeButton duration={3000} />;
}

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <KeyboardShortcutProvider>
            <CommandPaletteProvider>
                <ThemeProvider>
                    <TooltipProvider>
                        {children}
                        <CommandPalette />
                        <ShortcutHelpOverlay />
                        {/* CopyButton / CopyText, the optimistic-update hook and
                            the undo toast emit into this host; without it every
                            `toast()` call is a silent no-op. */}
                        <ThemedToaster />
                    </TooltipProvider>
                </ThemeProvider>
            </CommandPaletteProvider>
        </KeyboardShortcutProvider>
    );
}
