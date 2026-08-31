import { describe, expect, it } from 'vitest';
import {
  descriptionTextOf,
  PRESET_TOP_UP_MICROS,
  parseTopUpAmount,
  receiptUrlOf,
  toAutoTopUpInput,
  validateAutoTopUp,
} from './amounts';

/** $5, the API's default `minTopUpMicros`. */
const MIN = '5000000';

describe('parseTopUpAmount', () => {
  it('accepts a whole amount and a two-decimal one', () => {
    expect(parseTopUpAmount('25', MIN)).toEqual({ micros: '25000000' });
    expect(parseTopUpAmount('12.50', MIN)).toEqual({ micros: '12500000' });
  });

  it('does not lose a cent to floating point', () => {
    // 12.34 * 1_000_000 is 12339999.999999998 in IEEE 754.
    expect(parseTopUpAmount('12.34', MIN)).toEqual({ micros: '12340000' });
  });

  it('refuses an amount finer than a cent, which no provider can charge', () => {
    expect(parseTopUpAmount('12.345', MIN)).toEqual({ error: 'Amounts are charged in whole cents, e.g. 12.50.' });
  });

  it('refuses anything below the minimum, quoting it', () => {
    expect(parseTopUpAmount('1', MIN)).toEqual({ error: 'The minimum top-up is $5.00.' });
  });

  it('refuses text, an empty field and a negative amount', () => {
    expect(parseTopUpAmount('', MIN)).toEqual({ error: 'Enter an amount to buy.' });
    expect(parseTopUpAmount('twenty', MIN)).toEqual({ error: 'Enter an amount in dollars, e.g. 25 or 12.50.' });
    expect(parseTopUpAmount('-25', MIN)).toEqual({ error: 'Enter an amount in dollars, e.g. 25 or 12.50.' });
  });

  it('accepts every preset the card offers', () => {
    for (const micros of PRESET_TOP_UP_MICROS) {
      expect(parseTopUpAmount(String(Number(micros) / 1_000_000), MIN)).toEqual({ micros });
    }
  });
});

describe('validateAutoTopUp', () => {
  it('passes a complete, enabled setting', () => {
    expect(validateAutoTopUp({ enabled: true, threshold: '20', amount: '25' }, MIN)).toEqual({});
  });

  it('requires both fields when enabled', () => {
    const errors = validateAutoTopUp({ enabled: true, threshold: '', amount: '' }, MIN);
    expect(errors.threshold).toBe('Set the balance that triggers a top-up.');
    expect(errors.amount).toBe('Enter an amount to buy.');
  });

  it('holds the amount to the same minimum a manual top-up has', () => {
    expect(validateAutoTopUp({ enabled: true, threshold: '20', amount: '1' }, MIN).amount).toBe(
      'The minimum top-up is $5.00.',
    );
  });

  it('accepts a zero threshold — top up when the balance runs out', () => {
    expect(validateAutoTopUp({ enabled: true, threshold: '0', amount: '25' }, MIN)).toEqual({});
  });

  it('ignores the fields when the setting is being turned off', () => {
    expect(validateAutoTopUp({ enabled: false, threshold: 'nonsense', amount: '' }, MIN)).toEqual({});
  });
});

describe('toAutoTopUpInput', () => {
  it('clears both amounts when disabled, as the API does', () => {
    expect(toAutoTopUpInput({ enabled: false, threshold: '20', amount: '25' })).toEqual({
      enabled: false,
      thresholdMicros: null,
      amountMicros: null,
    });
  });

  it('sends micro-USD strings when enabled', () => {
    expect(toAutoTopUpInput({ enabled: true, threshold: '20', amount: '25.50' })).toEqual({
      enabled: true,
      thresholdMicros: '20000000',
      amountMicros: '25500000',
    });
  });
});

describe('receiptUrlOf', () => {
  it('finds the provider link in the note', () => {
    expect(receiptUrlOf('Credit purchase of $25.00 https://pay.stripe.com/receipts/abc')).toBe(
      'https://pay.stripe.com/receipts/abc',
    );
  });

  it('has no link for a note that carries none', () => {
    expect(receiptUrlOf('Automatic top-up of $25.00')).toBeNull();
    expect(receiptUrlOf(null)).toBeNull();
  });

  it('refuses a scheme other than https, which a description is free to name', () => {
    expect(receiptUrlOf('javascript:alert(1)')).toBeNull();
    expect(receiptUrlOf('See http://pay.example.com/receipt')).toBeNull();
  });
});

describe('descriptionTextOf', () => {
  it('drops the link so the note does not repeat it', () => {
    expect(descriptionTextOf('Credit purchase of $25.00 https://pay.stripe.com/receipts/abc')).toBe(
      'Credit purchase of $25.00',
    );
  });

  it('leaves a note without a link alone', () => {
    expect(descriptionTextOf('Automatic top-up of $25.00')).toBe('Automatic top-up of $25.00');
    expect(descriptionTextOf(null)).toBe('');
  });
});
