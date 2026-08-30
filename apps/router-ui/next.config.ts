import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // `libs/ui` ships TypeScript sources with no build step, so Next has to
  // compile it the same way it compiles this app's own code.
  transpilePackages: ['@confidential-router/ui'],
  // The console is deployed as a container next to router-api.
  output: 'standalone',
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
};

export default nextConfig;
