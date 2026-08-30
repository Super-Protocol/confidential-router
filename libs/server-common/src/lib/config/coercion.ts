import { z } from 'zod';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

/**
 * Environment variables are always strings, YAML values are already typed. Every
 * config field that can be set from both sources goes through one of these so a
 * single schema accepts `port: 3000` and `CR_API_SERVER__PORT=3000` alike.
 *
 * Note what is deliberately *not* here: a generic "looks numeric, so make it a
 * number" step applied to every env var. That would turn an all-digit secret
 * into a number and fail validation for a value that is perfectly valid.
 */
export function booleanish(): z.ZodType<boolean> {
  return z.preprocess((value) => {
    if (typeof value !== 'string') {
      return value;
    }
    const normalised = value.trim().toLowerCase();
    if (TRUE_VALUES.has(normalised)) {
      return true;
    }
    if (FALSE_VALUES.has(normalised)) {
      return false;
    }
    return value;
  }, z.boolean()) as z.ZodType<boolean>;
}

export function numberish(): z.ZodType<number> {
  return z.preprocess((value) => {
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
      return Number(value);
    }
    return value;
  }, z.number()) as z.ZodType<number>;
}

export function integerish(): z.ZodType<number> {
  return z.preprocess((value) => {
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
      return Number(value);
    }
    return value;
  }, z.number().int()) as z.ZodType<number>;
}

/** Accepts a YAML list or a comma-separated env string (`a,b,c`). */
export function stringArrayish(): z.ZodType<string[]> {
  return z.preprocess((value) => {
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
    }
    return value;
  }, z.array(z.string())) as z.ZodType<string[]>;
}
