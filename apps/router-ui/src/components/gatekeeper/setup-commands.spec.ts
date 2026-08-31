import { describe, expect, it } from 'vitest';
import { GATEKEEPER_LISTEN, SETUP_STEPS, setupScript } from './setup-commands';

describe('SETUP_STEPS', () => {
  it('is the four commands the gatekeeper CLI actually has, in the order they are run', () => {
    expect(SETUP_STEPS.map((step) => step.command.split(' ').slice(0, 3).join(' '))).toEqual([
      'gatekeeper init',
      'gatekeeper endpoint add',
      'gatekeeper endpoint trust',
      'gatekeeper run',
    ]);
  });

  it('binds the proxy to loopback — a gatekeeper on 0.0.0.0 is an open relay', () => {
    expect(GATEKEEPER_LISTEN.startsWith('127.0.0.1:')).toBe(true);
    expect(SETUP_STEPS[1].command).toContain(`--listen ${GATEKEEPER_LISTEN}`);
    expect(SETUP_STEPS[1].command).toContain('--upstream https://');
  });

  it('pins a digest against the same endpoint name it just added', () => {
    expect(SETUP_STEPS[2].command).toContain('<evidenceDigest>');
    expect(SETUP_STEPS[2].command.split(' ')[3]).toBe(SETUP_STEPS[1].command.split(' ')[2]);
  });
});

describe('setupScript', () => {
  it('is the four commands, one per line, ready to paste', () => {
    expect(setupScript().split('\n')).toHaveLength(4);
    expect(setupScript()).toBe(SETUP_STEPS.map((step) => step.command).join('\n'));
  });
});
