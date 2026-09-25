import { describe, expect, it } from 'vitest';
import { booleanFlag, integerFlag, parseArgs, requiredFlag, stringFlag, UsageError } from './args.js';

describe('parseArgs', () => {
  it('takes the first positional as the command', () => {
    expect(parseArgs(['generate', '--count', '5']).command).toBe('generate');
  });

  it('reads --flag value and --flag=value the same way', () => {
    expect(stringFlag(parseArgs(['--campaign', 'launch']), 'campaign')).toBe('launch');
    expect(stringFlag(parseArgs(['--campaign=launch']), 'campaign')).toBe('launch');
  });

  it('treats a flag followed by another flag as a switch', () => {
    const args = parseArgs(['generate', '--force', '--out', 'codes.csv']);

    expect(booleanFlag(args, 'force')).toBe(true);
    expect(stringFlag(args, 'out')).toBe('codes.csv');
  });

  it('treats a trailing flag as a switch', () => {
    expect(booleanFlag(parseArgs(['stats', '--help']), 'help')).toBe(true);
  });

  it('keeps a value that looks like a negative number', () => {
    expect(stringFlag(parseArgs(['--note', 'first batch']), 'note')).toBe('first batch');
  });

  it('has no command and no flags for an empty invocation', () => {
    expect(parseArgs([])).toMatchObject({ command: null });
    expect(parseArgs([]).flags.size).toBe(0);
  });

  it('refuses a bare --', () => {
    expect(() => parseArgs(['--'])).toThrow(UsageError);
  });
});

describe('reading flags', () => {
  it('refuses a switch where a value was needed', () => {
    expect(() => stringFlag(parseArgs(['--out']), 'out')).toThrow(UsageError);
  });

  it('refuses a missing required flag, naming it', () => {
    expect(() => requiredFlag(parseArgs([]), 'campaign')).toThrow(/--campaign is required/);
  });

  it('falls back when an integer flag is absent, and refuses one that is not a number', () => {
    expect(integerFlag(parseArgs([]), 'count', 7)).toBe(7);
    expect(integerFlag(parseArgs(['--count', '5000']), 'count', 7)).toBe(5000);
    expect(() => integerFlag(parseArgs(['--count', '5e3']), 'count', 7)).toThrow(UsageError);
    expect(() => integerFlag(parseArgs(['--count', '-1']), 'count', 7)).toThrow(UsageError);
  });

  it('reads --flag true as a boolean, for a scripted invocation', () => {
    expect(booleanFlag(parseArgs(['--force', 'true']), 'force')).toBe(true);
    expect(booleanFlag(parseArgs([]), 'force')).toBe(false);
  });
});
