/**
 * The router-api as a *process*, not as an imported module.
 *
 * `apps/router-api/test/*.e2e.spec.ts` boots the Nest application in-process,
 * which is the right shape for testing the application. It cannot show that the
 * built artefact starts, reads its configuration file, applies its migrations
 * and answers on a socket — and those are exactly the failures that only ever
 * happen outside a test runner. Everything here therefore goes through
 * `apps/router-api/dist/main.js` and plain HTTP.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Works from both `src/` (tsx, vitest) and `dist/`. */
export const REPO_ROOT = join(HERE, '..', '..', '..');
export const ROUTER_API_DIR = join(REPO_ROOT, 'apps', 'router-api');

/** How long the process gets to answer `/health` before we give up on it. */
const STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 100;

export interface RouterProcessOptions {
  port: number;
  /** The `router.yaml` this instance runs on. Written to a temp directory. */
  config: Record<string, unknown>;
  /** `CR_API_*` and friends, on top of the defaults below. */
  env?: Record<string, string>;
  /** PEM file added to the process's trust store — the mock evidence host's root. */
  extraCaFile?: string;
  /** Mirror the router's log to this process's stderr. */
  echoLog?: boolean;
}

export interface RouterProcess {
  readonly baseUrl: string;
  readonly port: number;
  /** Everything the process has written to stdout and stderr. */
  log(): string;
  /**
   * Resolves with the first log line matching `pattern`, waiting for it if it
   * has not been written yet. This is how the harness reads a magic link out of
   * the console mailer — the same way a person reads it out of `docker compose
   * logs`.
   */
  waitForLog(pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>;
  stop(): Promise<void>;
}

/**
 * Starts `node dist/main.js` and resolves once `/health` answers.
 *
 * A failure to start is reported with the process's own log attached: a bare
 * "timed out" would send the reader to a terminal that has already exited.
 */
export async function startRouterProcess(options: RouterProcessOptions): Promise<RouterProcess> {
  const directory = mkdtempSync(join(tmpdir(), 'cr-router-'));
  const configPath = join(directory, 'router.yaml');
  writeFileSync(configPath, toYaml(options.config), 'utf8');

  const child = spawn(process.execPath, [join(ROUTER_API_DIR, 'dist', 'main.js')], {
    cwd: directory,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      CR_API_CONFIG_FILE: configPath,
      CR_API_SERVER__PORT: String(options.port),
      CR_API_SERVER__HOST: '127.0.0.1',
      CR_API_DATABASE__TYPE: 'sqlite',
      CR_API_DATABASE__FILE: join(directory, 'router.sqlite'),
      CR_API_DATABASE__MIGRATIONS_RUN: 'true',
      CR_API_AUTH__SECRET: 'demo-secret-'.padEnd(48, 'x'),
      CR_API_LOG__PRETTY: 'false',
      CR_API_SWAGGER__ENABLED: 'false',
      ...(options.extraCaFile ? { NODE_EXTRA_CA_CERTS: options.extraCaFile } : {}),
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const buffer: string[] = [];
  const watchers: { pattern: RegExp; resolve: (match: RegExpMatchArray) => void }[] = [];
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    buffer.push(text);
    if (options.echoLog) {
      process.stderr.write(text);
    }
    for (let index = watchers.length - 1; index >= 0; index -= 1) {
      const match = text.match(watchers[index].pattern);
      if (match) {
        watchers[index].resolve(match);
        watchers.splice(index, 1);
      }
    }
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);

  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const baseUrl = `http://127.0.0.1:${options.port}`;
  const log = (): string => buffer.join('');

  const stop = async (): Promise<void> => {
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (!exited) {
        child.kill('SIGKILL');
      }
    }
    rmSync(directory, { recursive: true, force: true });
  };

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    if (exited) {
      await stop();
      throw new Error(
        `router-api exited before it was ready (code ${exited.code}, signal ${exited.signal}).\n${log()}`,
      );
    }
    if (await healthy(baseUrl)) {
      break;
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`router-api did not answer ${baseUrl}/health within ${STARTUP_TIMEOUT_MS}ms.\n${log()}`);
    }
    await delay(POLL_INTERVAL_MS);
  }

  return {
    baseUrl,
    port: options.port,
    log,
    waitForLog(pattern: RegExp, timeoutMs = 10_000): Promise<RegExpMatchArray> {
      const already = log().match(pattern);
      if (already) {
        return Promise.resolve(already);
      }
      return new Promise<RegExpMatchArray>((resolve, reject) => {
        const watcher = { pattern, resolve };
        watchers.push(watcher);
        setTimeout(() => {
          const index = watchers.indexOf(watcher);
          if (index >= 0) {
            watchers.splice(index, 1);
            reject(new Error(`no log line matched ${pattern} within ${timeoutMs}ms.\n${log()}`));
          }
        }, timeoutMs).unref();
      });
    },
    stop,
  };
}

async function healthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A YAML writer for the router config, in place of a `js-yaml` dependency.
 *
 * The document is ours and small — objects, arrays, strings, numbers, booleans
 * and nothing else — so JSON is valid YAML for it and quoting is never in
 * question. Anything richer belongs in a file a human wrote.
 */
export function toYaml(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
