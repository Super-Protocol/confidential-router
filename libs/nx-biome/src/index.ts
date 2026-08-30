import { dirname } from 'node:path';
import type { CreateNodesContextV2, CreateNodesV2, TargetConfiguration } from '@nx/devkit';
import { createNodesFromFiles } from '@nx/devkit';

export interface NxBiomePluginOptions {
  biomeCheckTargetName?: string;
  biomeCheckFixTargetName?: string;
}

/**
 * Any project that ships its own `biome.json` gets `lint` / `lint-fix` targets.
 * The workspace-root config is skipped so the root does not become a project.
 */
const biomeConfigGlob = '**/biome.json';

const biomeInputs: TargetConfiguration['inputs'] = [
  'default',
  '^default',
  '{workspaceRoot}/biome.json',
  '{projectRoot}/biome.json',
  { externalDependencies: ['@biomejs/biome'] },
];

function biomeCheckTarget(): TargetConfiguration {
  return {
    command: 'pnpm exec biome check {projectRoot}',
    cache: true,
    inputs: biomeInputs,
  };
}

function biomeCheckFixTarget(): TargetConfiguration {
  return {
    command: 'pnpm exec biome check --write {projectRoot}',
    cache: false,
    inputs: biomeInputs,
  };
}

function createNodesInternal(
  configFilePath: string,
  options: NxBiomePluginOptions | undefined,
  context: CreateNodesContextV2,
) {
  void context;
  const projectRoot = dirname(configFilePath);
  if (projectRoot === '.') {
    return {};
  }
  const checkName = options?.biomeCheckTargetName ?? 'lint';
  const fixName = options?.biomeCheckFixTargetName ?? 'lint-fix';
  return {
    projects: {
      [projectRoot]: {
        targets: {
          [checkName]: biomeCheckTarget(),
          [fixName]: biomeCheckFixTarget(),
        },
      },
    },
  };
}

export const createNodesV2: CreateNodesV2<NxBiomePluginOptions> = [
  biomeConfigGlob,
  async (configFiles, options, context) =>
    createNodesFromFiles(
      (configFilePath, opts, ctx) => createNodesInternal(configFilePath, opts, ctx),
      configFiles,
      options,
      context,
    ),
];
