import { describe, expect, it } from 'vitest';
import { EMPTY_ENDPOINT_FORM, type EndpointFormValues, toRegisterInput, validateEndpointForm } from './endpoint-form';

const FILLED: EndpointFormValues = {
  name: 'qwen3-coder',
  baseUrl: 'https://qwen3-coder.swarm.example',
  apiKey: 'sk-up-secret',
  models: [
    {
      id: 'qwen3-coder-30b:tdx',
      name: 'Qwen3 Coder 30B',
      upstreamModel: 'qwen3-coder-30b',
      contextLength: '131072',
      promptPer1m: '0.60',
      completionPer1m: '0.90',
    },
  ],
};

describe('validateEndpointForm', () => {
  it('accepts a complete form', () => {
    expect(validateEndpointForm(FILLED)).toEqual({});
  });

  it('asks for everything the empty form is missing', () => {
    const errors = validateEndpointForm(EMPTY_ENDPOINT_FORM);

    expect(Object.keys(errors).sort()).toEqual(
      [
        'apiKey',
        'baseUrl',
        'models.0.contextLength',
        'models.0.completionPer1m',
        'models.0.id',
        'models.0.name',
        'models.0.promptPer1m',
        'models.0.upstreamModel',
        'name',
      ].sort(),
    );
  });

  /**
   * The name is the sidecar's endpoint key, so a name this form accepted and the
   * sidecar rejected would fail at config reload — where no form is on screen to
   * say why.
   */
  it('holds the name to the kebab-case shape the sidecar requires', () => {
    expect(validateEndpointForm({ ...FILLED, name: 'Qwen3 Coder' }).name).toMatch(/lower-case/);
    expect(validateEndpointForm({ ...FILLED, name: '-leading' }).name).toMatch(/lower-case/);
    expect(validateEndpointForm({ ...FILLED, name: 'a'.repeat(65) }).name).toMatch(/64 characters/);
    expect(validateEndpointForm({ ...FILLED, name: 'a' }).name).toBeUndefined();
  });

  it('refuses a base URL a pinned certificate could never apply to', () => {
    expect(validateEndpointForm({ ...FILLED, baseUrl: 'http://insecure.example' }).baseUrl).toMatch(/https/);
    expect(validateEndpointForm({ ...FILLED, baseUrl: 'host.example' }).baseUrl).toMatch(/full URL/);
  });

  it('catches a model id listed twice, which would collide in the catalogue', () => {
    const duplicated = { ...FILLED, models: [FILLED.models[0], { ...FILLED.models[0], name: 'Copy' }] };

    expect(validateEndpointForm(duplicated)['models.1.id']).toBe('This id is listed twice.');
  });

  it('refuses a context length that is not a whole number of tokens', () => {
    expect(validateEndpointForm({ ...FILLED, models: [{ ...FILLED.models[0], contextLength: '0' }] })).toMatchObject({
      'models.0.contextLength': expect.stringContaining('whole number'),
    });
    expect(validateEndpointForm({ ...FILLED, models: [{ ...FILLED.models[0], contextLength: '8k' }] })).toMatchObject({
      'models.0.contextLength': expect.stringContaining('whole number'),
    });
  });

  it('asks for a missing context length rather than calling it malformed', () => {
    expect(validateEndpointForm({ ...FILLED, models: [{ ...FILLED.models[0], contextLength: ' ' }] })).toMatchObject({
      'models.0.contextLength': 'A context length is required.',
    });
  });

  it('refuses a price that is not a plain amount', () => {
    expect(validateEndpointForm({ ...FILLED, models: [{ ...FILLED.models[0], promptPer1m: '-1' }] })).toMatchObject({
      'models.0.promptPer1m': expect.stringContaining('USD'),
    });
    expect(
      validateEndpointForm({ ...FILLED, models: [{ ...FILLED.models[0], completionPer1m: '1.2345678' }] }),
    ).toMatchObject({ 'models.0.completionPer1m': expect.stringContaining('USD') });
  });

  /** Rotation reuses the form without a key, because the stored one is unreadable. */
  it('can be validated without a key', () => {
    expect(validateEndpointForm({ ...FILLED, apiKey: '' }, { requireKey: false })).toEqual({});
  });
});

describe('toRegisterInput', () => {
  it('trims the text fields and converts the prices to micros', () => {
    const input = toRegisterInput({
      ...FILLED,
      name: '  qwen3-coder  ',
      baseUrl: ' https://qwen3-coder.swarm.example ',
      models: [{ ...FILLED.models[0], id: ' qwen3-coder-30b:tdx ', promptPer1m: '0.60', completionPer1m: '1' }],
    });

    expect(input).toEqual({
      name: 'qwen3-coder',
      baseUrl: 'https://qwen3-coder.swarm.example',
      apiKey: 'sk-up-secret',
      models: [
        {
          id: 'qwen3-coder-30b:tdx',
          name: 'Qwen3 Coder 30B',
          upstreamModel: 'qwen3-coder-30b',
          contextLength: 131072,
          promptPer1mMicros: '600000',
          completionPer1mMicros: '1000000',
        },
      ],
    });
  });

  /**
   * The key is the one field that is not trimmed: whitespace could be part of a
   * credential the upstream issued, and a silently altered key fails as an
   * authentication error nobody can trace back to this form.
   */
  it('sends the key exactly as typed', () => {
    expect(toRegisterInput({ ...FILLED, apiKey: ' sk-up-padded ' }).apiKey).toBe(' sk-up-padded ');
  });
});
