import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // `libs/ui` ships TypeScript sources with no build step, so Next has to
  // compile it the same way it compiles this app's own code.
  transpilePackages: ['@confidential-router/ui'],
  turbopack: {
    resolveAlias: {
      /*
       * The attestation verifier is consumed as a *built* package, not as source.
       *
       * `tsconfig.base.json` maps every `@confidential-router/*` import to its
       * TypeScript sources — right for the Node projects, and the one thing
       * Turbopack cannot follow here: `libs/attestation` is a NodeNext library,
       * so its own imports are spelled `./cache.js`, and a bundler pointed at
       * `src/` has no `cache.js` to find. `dist/` is real JavaScript with the
       * extensions it names, and `router-ui:build` already depends on `^build`,
       * so it exists before Next looks for it.
       */
      '@confidential-router/attestation': '../../libs/attestation/dist/index.js',
    },
  },
  // The console is deployed as a container next to router-api.
  output: 'standalone',
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
};

export default nextConfig;
