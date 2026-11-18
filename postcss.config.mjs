// Tailwind 4 runs as a PostCSS plugin. Autoprefixing is built into
// Tailwind 4 (Lightning CSS), so `autoprefixer` is not listed.
const config = {
    plugins: {
        '@tailwindcss/postcss': {},
    },
};

export default config;
