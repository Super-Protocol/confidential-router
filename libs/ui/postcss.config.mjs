/**
 * Shared PostCSS config for every app that consumes `@confidential-router/ui`.
 * Tailwind 4 needs no `tailwind.config` — the theme lives in `globals.css`.
 */
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
