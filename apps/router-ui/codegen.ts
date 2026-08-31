import type { CodegenConfig } from '@graphql-codegen/cli';

/**
 * Types the console's operations against the schema router-api emits.
 *
 * `apps/router-api/schema.graphql` is committed and checked against the running
 * API on every CI run (`schema.spec.ts`, `test/schema.e2e.spec.ts`), so typing
 * the client against the file is typing it against the deployed server.
 * Pointing codegen at a file rather than at a running server is deliberate —
 * `pnpm nx run router-ui:codegen` has to work in CI and on a laptop with
 * nothing else started.
 *
 * `client-preset` emits typed document nodes consumed directly by Apollo's
 * `useQuery`/`useMutation`, instead of a generated hook per operation. It is the
 * combination that works with Apollo Client 4, where the React entry points moved
 * to `@apollo/client/react`.
 */
const config: CodegenConfig = {
  schema: '../router-api/schema.graphql',
  documents: ['src/**/*.{ts,tsx}', '!src/generated/**'],
  ignoreNoDocuments: false,
  generates: {
    'src/generated/': {
      preset: 'client',
      presetConfig: {
        fragmentMasking: false,
      },
      config: {
        useTypeImports: true,
        skipTypename: false,
        scalars: {
          DateTime: 'string',
          // Money is a `String` of integer micro-USD, not a custom scalar
          // (`docs/contracts/console-graphql.md`); `JSON` is the one opaque
          // field, the published evidence bundle.
          JSON: 'Record<string, unknown>',
        },
      },
    },
  },
};

export default config;
