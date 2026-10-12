import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Min, ValidateNested } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { VALIDATION_PIPE_OPTIONS } from '../bootstrap.js';
import { validationFailureOf } from './validation-error.js';

class Nested {
  @IsString()
  label!: string;
}

class Input {
  @IsString()
  name!: string;

  @IsOptional()
  @Matches(/^\d{1,15}$/)
  spendLimitMicros?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  requestsPerMinute?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => Nested)
  nested?: Nested;
}

const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

/** The pipe's refusal of one payload, read back the way the GraphQL layer reads it. */
async function refuse(value: Record<string, unknown>) {
  try {
    await pipe.transform(value, { type: 'body', metatype: Input });
    throw new Error('the pipe accepted it');
  } catch (caught) {
    expect(caught).toBeInstanceOf(BadRequestException);
    return validationFailureOf(caught);
  }
}

describe('the validation refusal the pipe throws', () => {
  it('names the field that was refused, which is where the console shows it', async () => {
    const failure = await refuse({ name: 'key', spendLimitMicros: 'lots' });

    expect(Object.keys(failure?.fields ?? {})).toEqual(['spendLimitMicros']);
    expect(failure?.fields.spendLimitMicros).toContain('spendLimitMicros');
  });

  it('keeps every constraint message, which is what the REST surface answers with', async () => {
    const failure = await refuse({ spendLimitMicros: 'lots', requestsPerMinute: 0 });

    expect(failure?.messages.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(failure?.fields ?? {}).sort()).toEqual(['name', 'requestsPerMinute', 'spendLimitMicros']);
  });

  it('still reports a property the whitelist stripped — the trap SUP-187 closed', async () => {
    const failure = await refuse({ name: 'key', surprise: 'x' });

    expect(failure?.messages.some((message) => message.includes('should not exist'))).toBe(true);
    expect(failure?.fields.surprise).toContain('should not exist');
  });

  it('reaches a nested property by its path', async () => {
    const failure = await refuse({ name: 'key', nested: { label: 42 } });

    expect(failure?.fields['nested.label']).toBeDefined();
  });

  it('is null for anything that is not a validation refusal', () => {
    expect(validationFailureOf(new BadRequestException('Unknown model id(s): nope.'))).toBeNull();
    expect(validationFailureOf(new Error('boom'))).toBeNull();
    expect(validationFailureOf(null)).toBeNull();
  });
});
