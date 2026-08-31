import { describe, expect, it } from 'vitest';
import { EMPTY_KEY_FORM, expiryInstant, keyFormOf, toCreateInput, toUpdateInput, validateKeyForm } from './key-form';
import type { ApiKeyRow } from './types';

const values = { ...EMPTY_KEY_FORM, name: 'production-agent' };

describe('validateKeyForm', () => {
  it('requires a name', () => {
    expect(validateKeyForm({ ...values, name: '   ' }).name).toBeDefined();
    expect(validateKeyForm(values)).toEqual({});
  });

  it('rejects a scope that restricts the key to nothing', () => {
    expect(validateKeyForm({ ...values, modelIds: [] }).modelIds).toBeDefined();
    expect(validateKeyForm({ ...values, modelIds: ['a'] }).modelIds).toBeUndefined();
  });

  it('rejects a spend limit that is not an amount, but allows none at all', () => {
    expect(validateKeyForm({ ...values, spendLimit: 'lots' }).spendLimit).toBeDefined();
    expect(validateKeyForm({ ...values, spendLimit: '' }).spendLimit).toBeUndefined();
    expect(validateKeyForm({ ...values, spendLimit: '25.50' }).spendLimit).toBeUndefined();
  });

  it('rejects a rate limit of zero or a fraction', () => {
    expect(validateKeyForm({ ...values, requestsPerMinute: '0' }).requestsPerMinute).toBeDefined();
    expect(validateKeyForm({ ...values, tokensPerMinute: '1.5' }).tokensPerMinute).toBeDefined();
    expect(validateKeyForm({ ...values, requestsPerMinute: '60' }).requestsPerMinute).toBeUndefined();
  });
});

describe('expiryInstant', () => {
  it('closes the chosen day rather than opening it', () => {
    expect(expiryInstant('2026-09-30')).toBe('2026-09-30T23:59:59.999Z');
  });

  it('treats an empty day as "never"', () => {
    expect(expiryInstant('')).toBeNull();
  });
});

describe('toCreateInput', () => {
  it('sends nulls for the limits the form left empty', () => {
    expect(toCreateInput(values, 'ws-1')).toEqual({
      workspaceId: 'ws-1',
      name: 'production-agent',
      modelIds: null,
      spendLimitMicros: null,
      expiresAt: null,
      requestsPerMinute: null,
      tokensPerMinute: null,
    });
  });

  it('converts dollars to micro-USD and trims the name', () => {
    const input = toCreateInput(
      { ...values, name: '  agent  ', spendLimit: '25.50', modelIds: ['m-1'], requestsPerMinute: '60' },
      'ws-1',
    );

    expect(input).toMatchObject({
      name: 'agent',
      spendLimitMicros: '25500000',
      modelIds: ['m-1'],
      requestsPerMinute: 60,
    });
  });
});

describe('toUpdateInput', () => {
  it('clears the scope with an empty list, which is how the API spells "all models"', () => {
    expect(toUpdateInput(values).modelIds).toEqual([]);
    expect(toUpdateInput({ ...values, modelIds: ['m-1'] }).modelIds).toEqual(['m-1']);
  });

  it('is the inverse of the form it was filled from', () => {
    const apiKey = {
      id: 'k-1',
      name: 'agent',
      prefix: 'sk-tee-v1-4f',
      modelScope: ['m-1'],
      createdAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-09-30T23:59:59.999Z',
      lastUsedAt: null,
      revokedAt: null,
      spendLimitMicros: '25500000',
      spentTotalMicros: '0',
      requestsPerMinute: 60,
      tokensPerMinute: null,
    } satisfies ApiKeyRow;

    expect(toUpdateInput(keyFormOf(apiKey))).toEqual({
      name: 'agent',
      modelIds: ['m-1'],
      spendLimitMicros: '25500000',
      expiresAt: '2026-09-30T23:59:59.999Z',
      requestsPerMinute: 60,
      tokensPerMinute: null,
    });
  });
});
