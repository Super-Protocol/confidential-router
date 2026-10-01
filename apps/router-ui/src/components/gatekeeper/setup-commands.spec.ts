import { describe, expect, it } from 'vitest';
import { GATEKEEPER_LISTEN, resolvedSetupScript, resolvedSetupSteps, SETUP_STEPS, setupScript } from './setup-commands';

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

describe('resolvedSetupSteps', () => {
  it('fills in the hostname and the pin so the commands need no editing', () => {
    const steps = resolvedSetupSteps({ hostname: 'router.example.test', evidenceDigestHex: 'ab'.repeat(32) });

    expect(steps.map((step) => step.command)).toEqual([
      'gatekeeper init',
      `gatekeeper endpoint add router --upstream https://router.example.test --listen ${GATEKEEPER_LISTEN}`,
      `gatekeeper endpoint trust add router sha256:${'ab'.repeat(32)}`,
      'gatekeeper run',
    ]);
  });

  it('leaves the pin as a placeholder when no digest is published', () => {
    // A `trust add` with nothing after it would look complete and trust nothing.
    const steps = resolvedSetupSteps({ hostname: 'router.example.test', evidenceDigestHex: null });

    expect(steps[2]?.command).toContain('sha256:<evidenceDigest>');
  });

  it('keeps the titles and the explanations of the generic steps', () => {
    const resolved = resolvedSetupSteps({ hostname: 'a.test' });

    expect(resolved.map((step) => step.title)).toEqual(SETUP_STEPS.map((step) => step.title));
    expect(resolved.map((step) => step.detail)).toEqual(SETUP_STEPS.map((step) => step.detail));
  });

  it('joins the resolved commands for the one-shot copy button', () => {
    const script = resolvedSetupScript({ hostname: 'a.test', evidenceDigestHex: 'cd'.repeat(32) });

    expect(script.split('\n')).toHaveLength(4);
    expect(script).toContain('https://a.test');
    expect(script).toContain(`sha256:${'cd'.repeat(32)}`);
  });
});
