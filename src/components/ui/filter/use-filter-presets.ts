'use client';

/**
 * Epic 53 — React bridge for filter presets.
 *
 * Wraps the pure CRUD module (`src/lib/filters/filter-presets.ts`)
 * with React state so the FilterToolbar preset dropdown re-renders
 * whenever the stored list changes. All the actual persistence
 * happens in the lib layer; this hook is purely a view adapter.
 */

import { useCallback, useEffect, useState } from 'react';
import { presetsStorageKey,
    clearPresets as clearPresetsLib,
    deletePreset as deletePresetLib,
    listPresets,
    renamePreset as renamePresetLib,
    savePreset as savePresetLib,
    type FilterPreset,
} from '@/lib/filters/filter-presets';
import type { FilterState } from './filter-state';

export interface UseFilterPresetsOptions {
    workspaceSlug: string;
    page: string;
}

export interface UseFilterPresetsResult {
    presets: FilterPreset[];
    savePreset: (name: string, state: FilterState) => FilterPreset | null;
    deletePreset: (id: string) => void;
    renamePreset: (id: string, name: string) => FilterPreset | null;
    clearAll: () => void;
    /** Force a re-read — useful after a non-React mutation in the same tab. */
    refresh: () => void;
}

export function useFilterPresets(
    options: UseFilterPresetsOptions,
): UseFilterPresetsResult {
    const { workspaceSlug, page } = options;
    const [presets, setPresets] = useState<FilterPreset[]>([]);

    const refresh = useCallback(() => {
        setPresets(listPresets(workspaceSlug, page));
    }, [workspaceSlug, page]);

    // Load once on mount (and again whenever the workspace / page scope
    // shifts).
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        refresh();
    }, [refresh]);

    // Listen for `storage` events so presets saved in another tab show
    // up immediately without a manual refresh.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const onStorage = (e: StorageEvent) => {
            if (e.key && e.key === presetsStorageKey(workspaceSlug, page)) {
                refresh();
            }
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, [workspaceSlug, page, refresh]);

    const savePreset = useCallback(
        (name: string, state: FilterState): FilterPreset | null => {
            try {
                const saved = savePresetLib({ workspaceSlug, page, name, state });
                refresh();
                return saved;
            } catch {
                return null;
            }
        },
        [workspaceSlug, page, refresh],
    );

    const deletePreset = useCallback(
        (id: string) => {
            deletePresetLib(workspaceSlug, page, id);
            refresh();
        },
        [workspaceSlug, page, refresh],
    );

    const renamePreset = useCallback(
        (id: string, name: string): FilterPreset | null => {
            try {
                const updated = renamePresetLib(workspaceSlug, page, id, name);
                if (updated) refresh();
                return updated;
            } catch {
                return null;
            }
        },
        [workspaceSlug, page, refresh],
    );

    const clearAll = useCallback(() => {
        clearPresetsLib(workspaceSlug, page);
        refresh();
    }, [workspaceSlug, page, refresh]);

    return { presets, savePreset, deletePreset, renamePreset, clearAll, refresh };
}
