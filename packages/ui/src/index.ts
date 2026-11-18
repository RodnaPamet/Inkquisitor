/**
 * The root entry of `@inkquisitor/ui`. It exports nothing, on purpose:
 * consumers deep-import each module by path
 * (`@inkquisitor/ui/components/ui/button`, `…/charts`, `…/lib/cn`), so a page
 * pulls in only the primitives it uses and no barrel decides the bundle.
 *
 * `export {}` keeps this file a MODULE rather than a global script, because
 * `package.json`'s `main` / `types` / `exports["."]` point here: a zero-byte
 * file would turn `import … from '@inkquisitor/ui'` into "File is not a
 * module".
 */
export {};
