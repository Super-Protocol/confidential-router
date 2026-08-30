# @confidential-router/server-common

Server-side plumbing shared by the TypeScript services: configuration loading and
structured logging. No framework dependency — nothing here imports NestJS.

Ported from swarm-cloud's `libs/server-common` (see `NOTICE`), with the
environment layer reworked: values stay strings and the schema decides what each
one becomes, so an all-digit secret is no longer silently turned into a number.

## Configuration

```ts
const config = validatedConfiguration(
  [yamlConfiguration<AppConfig>('conf/app.yaml'), envConfiguration<AppConfig>('CR_API')],
  AppConfigSchema,
)();
```

- `yamlConfiguration(path, env?)` — parses the file, expands `${VAR}` and
  `${VAR:-default}` placeholders, and returns `{}` when the file is absent. A
  placeholder with neither a value nor a default throws, naming every offender.
- `envConfiguration(prefix, env?)` — `PREFIX_A__B_C=x` sets `a.bC = "x"`. `__`
  separates object levels; each level is read as snake_case and camelised.
- `validatedConfiguration(loaders, schema)` — merges (later wins; arrays are
  replaced wholesale, not merged element-by-element) and validates once, throwing
  a `ConfigurationValidationError` that lists every invalid path.

Schema helpers for values that can arrive as either a string or their real type:
`booleanish()`, `numberish()`, `integerish()`, `stringArrayish()`, and
`durationMs('5s')`, which parses the `<n><ms|s|m|h>` grammar the JSON schemas use
into milliseconds.

## Logging

`createPinoHttpConfig({ level, quietPathPrefixes })` returns `pino-http` options
with the request id generated once — so pino's `req.id`, the log lines and the
`x-request-id` response header all carry the same value — and sensitive keys
redacted.

It deliberately sets no `transport`: pino transports run in a worker thread
loaded from disk, which does not survive bundling. A caller that wants pretty
output passes a `pino-pretty` stream alongside the options.
