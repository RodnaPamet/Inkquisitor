// The Inkquisitor help site, at https://rodnapamet.github.io/Inkquisitor/.
// Content comes from `node scripts/stage-docs.js`, which writes the
// allowlisted docs from docs/user/ into src/content/docs/ (generated and
// gitignored). Adapted from inflect-compliance's site/scripts/astro-site.mjs.
import { createRequire } from 'node:module';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const require = createRequire(import.meta.url);
const { SITE_BASE, SITE_TITLE, sidebarFrom, readManifest } = require('./scripts/stage-docs.js');

export default defineConfig({
    site: 'https://rodnapamet.github.io',
    base: SITE_BASE,
    trailingSlash: 'always',
    // An INLINE PostCSS config stops Vite searching upward and finding the
    // application's postcss.config.mjs, whose Tailwind plugin site/ does not
    // install.
    vite: { css: { postcss: {} } },
    integrations: [
        starlight({
            title: SITE_TITLE,
            description: 'How to use Inkquisitor: from a book concept to publishing readiness, by answering the questions it asks.',
            sidebar: sidebarFrom(readManifest()),
            credits: false,
        }),
    ],
});
