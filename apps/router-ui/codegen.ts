import type { CodegenConfig } from '@graphql-codegen/cli';

/**
 * Types the console's operations against the schema in `graphql/schema.graphql`.
 *
 * That file is an interim copy of the contract in `docs/contracts/console-graphql.md`;
 * SUP-76 replaces it with the schema router-api emits. Pointing codegen at a file
 * rather than a running server is deliberate — `pnpm nx run router-ui:codegen`
 * has to work in CI and on a laptop with nothing else started.
 *
 * `client-preset` emits typed document nodes consumed directly by Apollo's
 * `useQuery`/`useMutation`, instead of a generated hook per operation. It is the
 * combination that works with Apollo Client 4, where the React entry points moved
 * to `@apollo/client/react`.
 */
const config: CodegenConfig = {
  schema: 'graphql/schema.graphql',
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
          Micros: 'string',
          JSON: 'Record<string, unknown>',
        },
      },
    },
  },
};

export default config;
