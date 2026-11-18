/* eslint-disable @typescript-eslint/no-explicit-any -- the suite installs
 * and removes a fake `window` on globalThis and feeds deliberately mistyped
 * state through the sanitiser. */
/**
 * Epic 53 — filter presets contract.
 *
 * Tests the localStorage-backed CRUD layer. Uses an inline
 * `MemoryStorage` stub so the pure-node jest project can exercise
 * the real module without a browser.
 */

import {
    listPresets,
    savePreset,
    deletePreset,
    renamePreset,
    clearPresets,
    PRESET_LIMITS,
    presetsStorageKey,
} from '@/lib/filters/filter-presets';

class MemoryStorage implements Storage {
    private store = new Map<string, string>();
    get length() { return this.store.size; }
    clear() { this.store.clear(); }
    getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
    key(i: number) { return Array.from(this.store.keys())[i] ?? null; }
    removeItem(key: string) { this.store.delete(key); }
    setItem(key: string, value: string) { this.store.set(key, value); }
}

const WORKSPACE = 'acme';
const PAGE = 'books';

beforeEach(() => {
    const storage = new MemoryStorage();
    (globalThis as any).window = { localStorage: storage };
});

afterEach(() => {
    delete (globalThis as any).window;
});

describe('filter-presets — list/save/delete', () => {
    it('returns an empty array when nothing is stored', () => {
        expect(listPresets(WORKSPACE, PAGE)).toEqual([]);
    });

    it('saves a preset and reads it back', () => {
        const saved = savePreset({
            workspaceSlug: WORKSPACE,
            page: PAGE,
            name: 'My drafts',
            state: { status: ['DRAFTING', 'REVISING'], owner: ['me'] },
        });
        expect(saved.id).toBeTruthy();
        expect(saved.name).toBe('My drafts');
        expect(saved.state).toEqual({
            status: ['DRAFTING', 'REVISING'],
            owner: ['me'],
        });
        expect(saved.createdAt).toMatch(/\d{4}-\d{2}-\d{2}/);

        const list = listPresets(WORKSPACE, PAGE);
        expect(list).toHaveLength(1);
        expect(list[0]).toEqual(saved);
    });

    it('prepends new presets so the dropdown shows most-recent first', () => {
        const first = savePreset({ workspaceSlug: WORKSPACE, page: PAGE, name: 'First', state: {} });
        const second = savePreset({ workspaceSlug: WORKSPACE, page: PAGE, name: 'Second', state: {} });
        const list = listPresets(WORKSPACE, PAGE);
        expect(list.map((p) => p.id)).toEqual([second.id, first.id]);
    });

    it('caps the stored list at MAX_PRESETS_PER_PAGE, dropping the oldest', () => {
        for (let i = 0; i < PRESET_LIMITS.MAX_PRESETS_PER_PAGE + 3; i++) {
            savePreset({ workspaceSlug: WORKSPACE, page: PAGE, name: `p${i}`, state: {} });
        }
        const list = listPresets(WORKSPACE, PAGE);
        expect(list).toHaveLength(PRESET_LIMITS.MAX_PRESETS_PER_PAGE);
        // The three oldest (p0, p1, p2) must have been dropped.
        const names = list.map((p) => p.name);
        expect(names).not.toContain('p0');
        expect(names).not.toContain('p1');
        expect(names).not.toContain('p2');
    });

    it('stores under inkquisitor:filters:{workspaceSlug}:{page}', () => {
        savePreset({ workspaceSlug: WORKSPACE, page: PAGE, name: 'Mine', state: { stage: ['Drafting'] } });
        const storage = (globalThis as any).window.localStorage as Storage;
        expect(storage.length).toBe(1);
        expect(storage.key(0)).toBe(`inkquisitor:filters:${WORKSPACE}:${PAGE}`);
        expect(presetsStorageKey(WORKSPACE, PAGE)).toBe(`inkquisitor:filters:${WORKSPACE}:${PAGE}`);
    });

    it('isolates presets per workspace + page', () => {
        savePreset({ workspaceSlug: 'acme', page: 'books', name: 'A', state: {} });
        savePreset({ workspaceSlug: 'beta', page: 'books', name: 'B', state: {} });
        savePreset({ workspaceSlug: 'acme', page: 'notes', name: 'C', state: {} });

        expect(listPresets('acme', 'books').map((p) => p.name)).toEqual(['A']);
        expect(listPresets('beta', 'books').map((p) => p.name)).toEqual(['B']);
        expect(listPresets('acme', 'notes').map((p) => p.name)).toEqual(['C']);
    });

    it('deletePreset is idempotent', () => {
        const saved = savePreset({ workspaceSlug: WORKSPACE, page: PAGE, name: 'X', state: {} });
        deletePreset(WORKSPACE, PAGE, saved.id);
        deletePreset(WORKSPACE, PAGE, saved.id);
        deletePreset(WORKSPACE, PAGE, 'never-existed');
        expect(listPresets(WORKSPACE, PAGE)).toEqual([]);
    });

    it('renamePreset updates the name in place and returns the record', () => {
        const saved = savePreset({ workspaceSlug: WORKSPACE, page: PAGE, name: 'Old', state: {} });
        const updated = renamePreset(WORKSPACE, PAGE, saved.id, 'New');
        expect(updated?.name).toBe('New');
        const list = listPresets(WORKSPACE, PAGE);
        expect(list[0].name).toBe('New');
        expect(list[0].id).toBe(saved.id);
    });

    it('renamePreset returns null when the id is missing', () => {
        expect(renamePreset(WORKSPACE, PAGE, 'nope', 'Whatever')).toBeNull();
    });

    it('clearPresets removes every entry for the page', () => {
        savePreset({ workspaceSlug: WORKSPACE, page: PAGE, name: 'A', state: {} });
        savePreset({ workspaceSlug: WORKSPACE, page: PAGE, name: 'B', state: {} });
        clearPresets(WORKSPACE, PAGE);
        expect(listPresets(WORKSPACE, PAGE)).toEqual([]);
    });
});

describe('filter-presets — validation + sanitisation', () => {
    it('trims the name and truncates to MAX_NAME_LENGTH', () => {
        const long = 'x'.repeat(PRESET_LIMITS.MAX_NAME_LENGTH + 20);
        const saved = savePreset({ workspaceSlug: WORKSPACE, page: PAGE, name: `  ${long}  `, state: {} });
        expect(saved.name).toHaveLength(PRESET_LIMITS.MAX_NAME_LENGTH);
        expect(saved.name.startsWith('x')).toBe(true);
    });

    it('rejects empty / whitespace-only names', () => {
        expect(() =>
            savePreset({ workspaceSlug: WORKSPACE, page: PAGE, name: '   ', state: {} }),
        ).toThrow(/name is required/i);
        expect(() => renamePreset(WORKSPACE, PAGE, 'any', '')).toThrow(
            /name is required/i,
        );
    });

    it('drops non-string and empty values when sanitising state', () => {
        const saved = savePreset({
            workspaceSlug: WORKSPACE,
            page: PAGE,
            name: 'Clean',

            state: { status: ['DRAFTING', '', null as any, 42 as any], foo: 'bar' as any },
        });
        expect(saved.state).toEqual({ status: ['DRAFTING'] });
    });

    it('survives corrupt localStorage payloads', () => {
        const storage = (globalThis as any).window.localStorage as Storage;
        storage.setItem(`inkquisitor:filters:${WORKSPACE}:${PAGE}`, '{not valid json');
        expect(listPresets(WORKSPACE, PAGE)).toEqual([]);

        storage.setItem(`inkquisitor:filters:${WORKSPACE}:${PAGE}`, '"just a string"');
        expect(listPresets(WORKSPACE, PAGE)).toEqual([]);

        storage.setItem(
            `inkquisitor:filters:${WORKSPACE}:${PAGE}`,
            JSON.stringify([{ id: '', name: 'X', state: {}, createdAt: '' }]),
        );
        expect(listPresets(WORKSPACE, PAGE)).toEqual([]);
    });
});

describe('filter-presets — SSR / no-window safety', () => {
    beforeEach(() => {
        delete (globalThis as any).window;
    });

    it('listPresets returns empty when window is unavailable', () => {
        expect(listPresets(WORKSPACE, PAGE)).toEqual([]);
    });

    it('savePreset does not throw in a non-browser context', () => {
        expect(() =>
            savePreset({ workspaceSlug: WORKSPACE, page: PAGE, name: 'n', state: {} }),
        ).not.toThrow();
    });

    it('clearPresets is a no-op when window is unavailable', () => {
        expect(() => clearPresets(WORKSPACE, PAGE)).not.toThrow();
    });
});
