/**
 * Re-export of `@inkquisitor/ui/components/ui/card-variants`.
 *
 * The implementation lives in the workspace package. This path stays because
 * the app-side primitives, shells and tests lifted from inflect-compliance
 * import it as `@/components/ui/card-variants`, exactly as inflect's do, which
 * keeps those files comparable line for line with their source (see
 * docs/carve-manifest.md). New code may import either path.
 *
 * Add nothing here: a test that reads this file for content would find only
 * the re-export. Content checks read the package file.
 */
export * from '@inkquisitor/ui/components/ui/card-variants';
