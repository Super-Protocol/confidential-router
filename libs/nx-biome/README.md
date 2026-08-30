# @confidential-router/nx-biome

Tiny Nx inference plugin: every project directory that contains a `biome.json`
gets `lint` (`biome check`) and `lint-fix` (`biome check --write`) targets, so
`nx affected -t lint` works without repeating the command in every
`project.json`.

Ported from the `@swarm-cloud/nx-biome` plugin in
[Super-Protocol/swarm-cloud](https://github.com/Super-Protocol/swarm-cloud)
(see `NOTICE`).

The plugin is compiled by the root `prepare` script (`tsc -p
libs/nx-biome/tsconfig.lib.json`) so it is available to Nx immediately after
`pnpm install`.
