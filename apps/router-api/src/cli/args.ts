/**
 * The smallest argument parser that covers this service's CLIs.
 *
 * Hand-rolled rather than a dependency because the whole grammar is
 * `<command> --flag value` with no short forms, no clustering and no
 * subcommand-specific help text, and because everything in `dependencies` ends up
 * in the runtime image (`tools/runtime-deps.cjs`) — a 40-line parser is cheaper
 * than that.
 */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface ParsedArgs {
  /** The first positional argument, if any. */
  command: string | null;
  /** `--flag value` pairs; a flag with no value is `true`. */
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  let command: string | null = null;

  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at];
    if (!token.startsWith('--')) {
      command ??= token;
      continue;
    }
    const name = token.slice(2);
    if (name.length === 0) {
      throw new UsageError('“--” is not a flag.');
    }
    const equals = name.indexOf('=');
    if (equals > 0) {
      flags.set(name.slice(0, equals), name.slice(equals + 1));
      continue;
    }
    const next = argv[at + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(name, true);
      continue;
    }
    flags.set(name, next);
    at += 1;
  }

  return { command, flags };
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === true) {
    throw new UsageError(`--${name} needs a value.`);
  }
  return value;
}

export function requiredFlag(args: ParsedArgs, name: string): string {
  const value = stringFlag(args, name);
  if (value === undefined || value.length === 0) {
    throw new UsageError(`--${name} is required.`);
  }
  return value;
}

export function integerFlag(args: ParsedArgs, name: string, fallback: number): number {
  const value = stringFlag(args, name);
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`--${name} must be a whole number, got “${value}”.`);
  }
  return Number(value);
}

export function booleanFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true';
}
