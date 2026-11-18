# `@inkquisitor/ui`

Inkquisitor's product-neutral UI primitives: the button, card, tooltip,
typography, empty and error states, skeletons, the shared hooks, the icon set,
the visx chart platform (`components/ui/charts`) and the `cn` / date and
number formatting helpers. Lifted from
inflect-compliance's `@inflect/ui` at `5528464` (owner decision D6: copied at
a recorded commit, never shared); every file is listed in
`docs/carve-manifest.md`.

Consumed as an npm workspace (root `package.json` → `"workspaces":
["packages/*"]`). There is no build step: the package ships `.ts`/`.tsx`
sources and the app compiles them, because the app's Tailwind has to see the
class strings anyway. Imports use the deep path,
`@inkquisitor/ui/components/ui/button`; `tsconfig.json` maps
`@inkquisitor/ui/*` to `packages/ui/src/*` and Jest does the same
(`jest.config.js`), since jest-resolve does not honour the `exports` array.

## What may be imported from inside this package

1. Itself, by relative path or by `@inkquisitor/ui/…`.
2. The declared `peerDependencies` — `react`, `react-dom`, `next`,
   `next-intl` — and the libraries the app installs for it (Radix,
   `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`,
   `sonner`, `date-fns`, `canvas-confetti`, `motion`, the `@visx/*` family
   and `d3-array` for the charts).
3. **Nothing from the app**: no `@/…`. `tsconfig.json` here resets `paths`
   and `baseUrl` so `@/` does not resolve when the package is compiled on
   its own.

## Tokens

`tokens.contract.css` names the theme tokens the components consume, each
with a neutral fallback so a forgotten override renders visibly wrong rather
than transparent. The real palette — ink black, parchment, one violet-ink
accent, in light and dark — lives in the app at `src/styles/tokens.css`,
which also defines the six `--chart-series-*` gradient pairs the charts read
(series 1 is the accent; the rest are low-saturation ink companions).

## Left behind

The Nucleo icon set (`icons/nucleo/`) was not
lifted because its licence restricts the icons to the product they ship
with; the primitives that drew Nucleo glyphs draw lucide-react ones instead.
