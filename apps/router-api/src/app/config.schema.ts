import { booleanish, durationMs, integerish, stringArrayish } from '@confidential-router/server-common';
import { z } from 'zod';

/**
 * Runtime shape of `conf/router.yaml`. It is the Zod mirror of
 * `schemas/router-config.schema.json`; `config.spec.ts` parses the committed
 * example against this schema so the two cannot drift.
 *
 * Two deliberate differences from the JSON Schema:
 *  - durations (`5s`, `24h`) are parsed into milliseconds here, because nothing
 *    downstream should have to know the string grammar;
 *  - `endpoints` and `models` default to empty. The JSON Schema requires at
 *    least one of each because a *deployment* with none is a mistake; a
 *    developer running `nx serve` with no config at all is not.
 */

const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'must be a lowercase kebab-case name');

const ServerSchema = z
  .object({
    port: integerish().pipe(z.number().int().min(1).max(65535)).prefault(3000),
    host: z.string().prefault('0.0.0.0'),
    publicBaseUrl: z.url().prefault('http://localhost:3000'),
    validClientOrigins: stringArrayish().prefault([]),
  })
  .prefault({});

const DatabaseSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('sqlite'),
      /** Relative paths resolve against the process working directory. */
      file: z.string().min(1).prefault('data/router-api.sqlite'),
      migrationsRun: booleanish().prefault(true),
      logging: booleanish().prefault(false),
    }),
    z.object({
      type: z.literal('postgres'),
      url: z.string().min(1),
      /**
       * Off by default: a PostgreSQL deployment runs `router-api-migrate` once,
       * from one place, rather than racing every replica at boot.
       */
      migrationsRun: booleanish().prefault(false),
      logging: booleanish().prefault(false),
    }),
  ])
  .prefault({ type: 'sqlite' });

const LiteLlmSchema = z
  .object({
    baseUrl: z.url().prefault('http://127.0.0.1:4000'),
    apiKey: z.string().optional(),
    connectTimeout: durationMs('5s'),
    readTimeout: durationMs('120s'),
  })
  .prefault({});

const BackendsSchema = z.object({ litellm: LiteLlmSchema }).prefault({});

const EndpointSchema = z.object({
  name,
  hostname: z.string().min(1),
  tee: z.string().min(1),
  evidenceUrl: z.url().optional(),
  enabled: booleanish().prefault(true),
});

const ModelSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(:[a-z0-9-]+)?$/, 'must look like "vendor/model[:variant]"'),
  name: z.string().min(1),
  litellmModel: z.string().min(1),
  endpoint: name,
  contextLength: integerish().pipe(z.number().int().positive()),
  capabilities: z.array(z.enum(['chat', 'completions', 'embeddings'])).prefault(['chat', 'completions']),
  pricing: z.object({
    promptPer1mMicros: integerish().pipe(z.number().int().nonnegative()),
    completionPer1mMicros: integerish().pipe(z.number().int().nonnegative()),
  }),
  enabled: booleanish().prefault(true),
});

const EvidenceSchema = z
  .object({
    pollInterval: durationMs('5m'),
    freshnessWindow: durationMs('24h'),
  })
  .prefault({});

const RateLimitsSchema = z
  .object({
    requestsPerMinute: integerish().pipe(z.number().int().positive()).prefault(600),
    tokensPerMinute: integerish().pipe(z.number().int().positive()).prefault(2_000_000),
  })
  .prefault({});

const OAuthClientSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

const AuthSchema = z
  .object({
    baseUrl: z.url().prefault('http://localhost:3000'),
    /**
     * Signs session cookies and magic-link tokens. Never defaulted: `loadConfig`
     * mints an ephemeral one outside production and refuses to boot without it
     * in production, so a deployment cannot silently run on a guessable secret.
     */
    secret: z.string().min(32, 'must be at least 32 characters'),
    sessionMaxAge: durationMs('720h'),
    github: OAuthClientSchema.optional(),
    google: OAuthClientSchema.optional(),
    magicLink: z
      .object({
        mailer: z.enum(['console', 'smtp', 'resend']).prefault('console'),
        from: z.email().prefault('no-reply@confidential-router.local'),
        smtpUrl: z.string().optional(),
        resendApiKey: z.string().optional(),
      })
      .prefault({}),
  })
  // No `.prefault({})`: `auth.secret` has no default, and the config loader
  // guarantees the section exists before this schema ever runs.
  .strict();

const BillingSchema = z
  .object({
    minTopUpMicros: integerish().pipe(z.number().int().nonnegative()).prefault(5_000_000),
    allowOverdraftMicros: integerish().pipe(z.number().int().nonnegative()).prefault(0),
    stripe: z
      .object({
        secretKey: z.string().min(1),
        webhookSecret: z.string().min(1),
        currency: z
          .string()
          .regex(/^[a-z]{3}$/)
          .prefault('usd'),
      })
      .optional(),
  })
  .prefault({});

const LogSchema = z
  .object({
    level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).prefault('info'),
    /** Human-readable output; defaults to on outside production. */
    pretty: booleanish().prefault(process.env.NODE_ENV !== 'production'),
  })
  .prefault({});

const GraphqlSchema = z
  .object({
    path: z.string().prefault('/graphql'),
    introspection: booleanish().prefault(process.env.NODE_ENV !== 'production'),
  })
  .prefault({});

const SwaggerSchema = z
  .object({
    enabled: booleanish().prefault(process.env.NODE_ENV !== 'production'),
    path: z.string().prefault('docs'),
  })
  .prefault({});

export const RouterConfigSchema = z.object({
  version: z.literal(1).prefault(1),
  server: ServerSchema,
  database: DatabaseSchema,
  backends: BackendsSchema,
  endpoints: z.array(EndpointSchema).prefault([]),
  models: z.array(ModelSchema).prefault([]),
  evidence: EvidenceSchema,
  rateLimits: RateLimitsSchema,
  auth: AuthSchema,
  billing: BillingSchema,
  log: LogSchema,
  graphql: GraphqlSchema,
  swagger: SwaggerSchema,
});

export type RouterConfig = z.infer<typeof RouterConfigSchema>;
export type DatabaseConfig = RouterConfig['database'];
export type AuthConfig = RouterConfig['auth'];
