/**
 * Drives the real `gatekeeper` binary from a script.
 *
 * Every command goes through `apps/gatekeeper/bin/gatekeeper` — the artefact
 * GoReleaser publishes, not a Go test harness — with `--config` pointed at a
 * throwaway file. That is the point of the demo: the story has to be tellable
 * with the commands a user actually types, in the order the `init` output tells
 * them to type them.
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { delay, REPO_ROOT } from './router-process.js';

const execFileAsync = promisify(execFile);

export const GATEKEEPER_BIN = join(REPO_ROOT, 'apps', 'gatekeeper', 'bin', 'gatekeeper');

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Gatekeeper {
  readonly configPath: string;
  /** Runs one command; a non-zero exit is returned, not thrown. */
  run(...args: string[]): Promise<CommandResult>;
  /** Runs one command and throws with both streams attached if it fails. */
  mustRun(...args: string[]): Promise<CommandResult>;
  /**
   * Starts `gatekeeper run --headless` and waits for the listener to answer.
   * `flags` are appended to the command — the demo shortens the re-attestation
   * interval so a rotation is noticed while someone is watching.
   */
  start(listen: string, ...flags: string[]): Promise<RunningGatekeeper>;
  cleanup(): void;
}

export interface RunningGatekeeper {
  /** Everything the daemon has logged so far. */
  log(): string;
  /** SIGHUP: re-read the configuration file in place, as a user would. */
  reload(): void;
  stop(): Promise<void>;
}

export function createGatekeeper(): Gatekeeper {
  const directory = mkdtempSync(join(tmpdir(), 'cr-gatekeeper-'));
  const configPath = join(directory, 'config.yaml');

  const run = async (...args: string[]): Promise<CommandResult> => {
    try {
      const { stdout, stderr } = await execFileAsync(GATEKEEPER_BIN, ['--config', configPath, ...args], {
        maxBuffer: 8 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string; message: string };
      if (typeof failure.code !== 'number') {
        throw error;
      }
      return { code: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  };

  return {
    configPath,
    run,
    async mustRun(...args: string[]): Promise<CommandResult> {
      const result = await run(...args);
      if (result.code !== 0) {
        throw new Error(
          `gatekeeper ${args.join(' ')} exited ${result.code}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`,
        );
      }
      return result;
    },
    async start(listen: string, ...flags: string[]): Promise<RunningGatekeeper> {
      return startDaemon(configPath, listen, flags);
    },
    cleanup(): void {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** How long the proxy gets to bind its listener before we call it broken. */
const LISTEN_TIMEOUT_MS = 30_000;

async function startDaemon(configPath: string, listen: string, flags: string[]): Promise<RunningGatekeeper> {
  const child: ChildProcess = spawn(GATEKEEPER_BIN, ['--config', configPath, ...flags, 'run', '--headless'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const buffer: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => buffer.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => buffer.push(chunk.toString('utf8')));

  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const log = (): string => buffer.join('');
  const stop = async (): Promise<void> => {
    if (exited) {
      return;
    }
    child.kill('SIGTERM');
    await Promise.race([new Promise<void>((resolve) => child.once('exit', () => resolve())), delay(5_000)]);
    if (!exited) {
      child.kill('SIGKILL');
    }
  };

  // The listener is up when the port accepts a connection. A verdict may not
  // exist yet — that is the fail-closed window the demo goes on to exercise, so
  // waiting for one here would hide it.
  const deadline = Date.now() + LISTEN_TIMEOUT_MS;
  for (;;) {
    if (exited) {
      throw new Error(`gatekeeper run exited before it bound ${listen}\n${log()}`);
    }
    if (await accepting(listen)) {
      return {
        log,
        reload: () => child.kill('SIGHUP'),
        stop,
      };
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`gatekeeper did not bind ${listen} within ${LISTEN_TIMEOUT_MS}ms\n${log()}`);
    }
    await delay(100);
  }
}

async function accepting(listen: string): Promise<boolean> {
  const { connect } = await import('node:net');
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: listen.split(':')[0], port: Number(listen.split(':')[1]) });
    const settle = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('timeout', () => settle(false));
  });
}
