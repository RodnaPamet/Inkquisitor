# Enterprise Filter System — Developer Guide

> `src/components/ui/filter/` — lifted from inflect-compliance (Epic 53).
> The single source of truth for filter UI, state, and URL synchronization.

## Quick Start — Adding Filters to a List Page

```tsx
// 1. Define filters (in a constants file or inline)
import { createFilterDefs, optionsFromEnum } from '@/components/ui/filter';
import { CircleDot, Tag } from 'lucide-react';

const bookFilterDefs = createFilterDefs<Book>({
  stage: {
    label: 'Stage',
    icon: CircleDot,
    options: optionsFromEnum({
      CONCEPT: 'Concept',
      DRAFTING: 'Drafting',
      REVISING: 'Revising',
    }),
  },
  genre: {
    label: 'Genre',
    icon: Tag,
    multiple: true,
    options: optionsFromArray(['Mystery', 'Fantasy', 'Romance']),
  },
});

// 2. Wire up in your page component
import { useFilterContext, FilterProvider } from '@/components/ui/filter';

export function BooksClient({ initialFilters }: { initialFilters: Record<string, string> }) {
  const filterCtx = useFilterContext(
    bookFilterDefs.filters,
    bookFilterDefs.filterKeys,
    // The page's searchParams, so the server render and the client's first
    // render agree (see "Server filters" below).
    { serverFilters: initialFilters },
  );

  return (
    <FilterProvider value={filterCtx}>
      {/* Filter UI and DataTable go here */}
    </FilterProvider>
  );
}
```

---

## Architecture

```
src/components/ui/filter/
├── index.ts               ← Barrel export (public API)
├── types.ts               ← Core types: Filter, FilterOption, ActiveFilter
├── filter-state.ts        ← Pure state functions (URL ↔ FilterState ↔ ActiveFilter)
├── filter-definitions.ts  ← createFilterDefs<T>, optionsFromEnum, optionsFromArray
├── filter-context.tsx     ← React context + useFilterContext + useFilters
├── filter-select.tsx      ← Filter.Select — command-palette picker (cmdk)
├── filter-list.tsx        ← Filter.List — active filter pills
├── filter-range-panel.tsx ← Range filter panel (internal)
└── filter-scroll.tsx      ← Scroll container (internal)
```

### Module Responsibilities

| Module | Purpose | Pure? |
|--------|---------|-------|
| `filter-state.ts` | URL parsing, state mutations, compatibility bridges | ✅ Yes |
| `filter-definitions.ts` | Factory for typed filter configs | ✅ Yes |
| `filter-context.tsx` | React context, URL sync hook | ❌ React |
| `filter-select.tsx` | Dropdown command palette | ❌ React |
| `filter-list.tsx` | Active filter pill strip | ❌ React |

---

## Filter Definitions

### `createFilterDefs<T>(defs)`

Creates a strongly-typed filter config from a plain object:

```tsx
const myFilters = createFilterDefs<MyEntity>({
  status: {
    label: 'Status',
    icon: CircleDot,
    options: [{ value: 'OPEN', label: 'Open' }],
  },
});

// Returns:
myFilters.filters     // FilterDef[] for Filter.Select
myFilters.filterKeys  // string[] for useFilterContext
myFilters.getFilter('status') // lookup by key
```

### Option Helpers

```tsx
// From enum-like object
optionsFromEnum({ OPEN: 'Open', CLOSED: 'Closed' })

// From string array
optionsFromArray(['Mystery', 'Fantasy'])

// From API data (dynamic)
extractFilterOptions(data, 'status', (v) => prettifyStatus(v))
```

---

## State Management

### Pure Functions (`filter-state.ts`)

All state functions are pure and return new objects (immutable):

```tsx
import {
  addFilterValue,
  removeFilterValue,
  toggleFilterValue,
  setFilterValue,
  removeFilter,
  clearAllFilters,
} from '@/components/ui/filter';

// Add
addFilterValue(state, 'status', 'OPEN')
addFilterValue(state, 'status', ['OPEN', 'CLOSED'])

// Remove
removeFilterValue(state, 'status', 'OPEN')
removeFilter(state, 'status')       // remove entire key
clearAllFilters()                    // empty state

// Toggle (add if absent, remove if present)
toggleFilterValue(state, 'status', 'OPEN')

// Set (replace all values for a key)
setFilterValue(state, 'status', 'OPEN')
```

### URL Synchronization

```tsx
import {
  parseUrlToFilterState,
  filterStateToUrlParams,
  filterStateToActiveFilters,
} from '@/components/ui/filter';

// URL → state
const state = parseUrlToFilterState(window.location.search, ['status', 'category']);

// State → URL
const params = filterStateToUrlParams(state);

// State → UI (for Filter.Select/Filter.List)
const activeFilters = filterStateToActiveFilters(state);
```

### React Context (`useFilterContext`)

The primary hook for page-level filter setup:

```tsx
const filterCtx = useFilterContext(
  myFilters.filters,
  myFilters.filterKeys,
  {
    syncUrl: true,           // sync to URL (default: true)
    urlConfig: {
      separator: ',',        // multi-value separator
      prefix: '',            // param prefix (e.g., 'f_')
    },
    serverFilters: props.serverFilters, // SSR hydration
  },
);
```

### Server filters

With `syncUrl` on (the default) the client's FIRST render reads the filter
state from `window.location.search`, but the server render cannot see the
browser's URL. Pass the page's `searchParams` as `serverFilters` (a
`Record<string, string>`, multi-values comma-joined) so both renders start
from the same state; otherwise a reload of a filtered URL renders pills on the
client that the server HTML did not have, and React reports a hydration
mismatch. A toolbar that should never touch the URL passes `syncUrl: false`
instead. `/dev/kitchen-sink` shows the first pattern, and
`tests/rendered/kitchen-sink-filter-hydration.test.tsx` holds it.

```tsx
// Use in children via:
const { state, set, toggle, clearAll, hasActive, search, setSearch } = useFilters();
```

---

## Flat-record bridges

For code that holds filters as a flat `Record<string, string>` (one value per
key, as `serverFilters` does), two bridges convert to and from `FilterState`:

```tsx
import { fromCompactFilterState, toCompactFilterState } from '@/components/ui/filter';

const state = fromCompactFilterState({ stage: 'DRAFTING', q: 'lantern' });
// → { stage: ['DRAFTING'], q: ['lantern'] }

const flat = toCompactFilterState(state);
// → { stage: 'DRAFTING', q: 'lantern' }
```

---

## DO / DON'T

### ✅ DO

- Import from the barrel: `from '@/components/ui/filter'`
- Use `createFilterDefs` for typed definitions
- Use `useFilterContext` for page-level state
- Use `useFilters()` in child components to access state
- Keep filter configs colocated with their page or in a shared constants file
- Test pure state functions directly (no React needed)

### ❌ DON'T

- Import from internal modules (`filter-range-panel`, `filter-scroll`)
- Create ad-hoc filter state management (`useState` + manual URL sync)
- Hardcode entity-specific logic in the shared filter module
- Use raw `URLSearchParams` manipulation for filter state

---

## Query Helpers

```tsx
import {
  isFilterActive,
  isValueSelected,
  countActiveFilters,
  countActiveFilterKeys,
  hasActiveFilters,
} from '@/components/ui/filter';

isFilterActive(state, 'stage')            // boolean
isValueSelected(state, 'stage', 'DRAFTING') // boolean
countActiveFilters(state)                  // total values across all keys
countActiveFilterKeys(state)              // number of active keys
hasActiveFilters(state)                   // any filters active?
```

---

## Testing

- **Pure functions**: `tests/unit/filter-system.test.ts` covers the state
  mutations, URL round trips and the definition factories without React.
- **Presets**: `tests/unit/filter-presets.test.ts` covers the saved-view store.
- **Components**: `tests/rendered/filter-toolbar-live-search.test.tsx`,
  `filter-select-enter-no-match.test.tsx` and
  `use-filter-card-visibility.test.tsx` render the toolbar and its parts.
- No guard checks that list pages use this system; it is a convention.

---

## Adding a filter to a new list page

### 1. Define the filter config

Colocate the defs with the page:

```tsx
// src/app/(app)/books/filter-defs.ts
import type { FilterDefInput } from '@/components/ui/filter/filter-definitions';
import { createTypedFilterDefs, optionsFromEnum } from '@/components/ui/filter/filter-definitions';
import { CircleDot } from 'lucide-react';

export const BOOK_STAGE_LABELS = {
  CONCEPT: 'Concept',
  DRAFTING: 'Drafting',
} as const;

const STATIC_DEFS = {
  stage: {
    label: 'Stage',
    description: 'Where the book is.',
    group: 'Attributes',
    icon: CircleDot,
    options: optionsFromEnum(BOOK_STAGE_LABELS),
    multiple: true,
    resetBehavior: 'clearable',
  },
} satisfies Record<string, FilterDefInput>;

export const bookFilterDefs = createTypedFilterDefs()(STATIC_DEFS);
export const BOOK_FILTER_KEYS = bookFilterDefs.filterKeys;
```

> **Import from `filter-definitions` / `types` / `filter-state` directly**, not the
> `@/components/ui/filter` barrel, in a config file: the barrel pulls in `.tsx`
> components, and the sub-modules keep the config loadable by a node-environment test.

### 2. Wire the toolbar into the page

Wrap the client island in a `FilterProvider` at the outer boundary, and pass the
page's `searchParams` through as `serverFilters`:

```tsx
// src/app/(app)/books/BooksClient.tsx
'use client';
import { FilterProvider, useFilterContext } from '@/components/ui/filter';
import { FilterToolbar } from '@/components/filters/FilterToolbar';
import { bookFilterDefs, BOOK_FILTER_KEYS } from './filter-defs';

export function BooksClient({ initialFilters }: { initialFilters: Record<string, string> }) {
  const filterCtx = useFilterContext(bookFilterDefs.filters, BOOK_FILTER_KEYS, {
    serverFilters: initialFilters,
  });
  return (
    <FilterProvider value={filterCtx}>
      <FilterToolbar
        filters={bookFilterDefs.filters}
        searchId="books-search"
        searchPlaceholder="Search books…"
      />
      {/* <DataTable …/> reading useFilters().state */}
    </FilterProvider>
  );
}
```

### 3. URL sync

Nothing to do — `useFilterContext` writes to the URL, and browser
back/forward replays via the context's popstate handler. Turning state into an
API query is the page's job (inflect-compliance's `url-sync` helpers were not
lifted).

### 4. Do not

- Do not build a bespoke toolbar. Compose `<FilterToolbar>`; if you need a page-specific
  gesture, add it next to the toolbar, not inside it.
- Do not re-export `filter-defs.ts` through a barrel. Filter defs stay colocated with
  their page so option derivation lives next to the data fetch.
