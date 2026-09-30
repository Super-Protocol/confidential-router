import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { TypeMetadataStorage } from '@nestjs/graphql';
import { beforeAll, describe, expect, it } from 'vitest';
import { VALIDATION_PIPE_OPTIONS } from '../../bootstrap.js';
import { buildConsoleSchema } from './console-schema.js';

/**
 * Every argument the console can send, put through the pipe that will actually
 * receive it.
 *
 * The trap this closes is not a missing check — it is a dead mutation.
 * `VALIDATION_PIPE_OPTIONS` sets `whitelist`, which keeps only the properties
 * carrying at least one class-validator decorator, and `forbidNonWhitelisted`,
 * which then refuses the whole request because a property it has just stripped
 * "should not exist". So an `@Field` with no validator does not let a bad value
 * through: it makes every call carrying that field a `400`, whatever the value.
 *
 * That is how `AppendChatMessageInput.role` shipped (SUP-187) — the console
 * could not store a single chat message, and no unit test noticed, because a
 * resolver or service spec constructs the input class directly and never goes
 * near the pipe. Two comments in this codebase already warned about the trap
 * (`activity.args.ts`, `evidence.model.ts`); a comment is not a check.
 *
 * Walking the schema rather than listing classes is the point: a new input type
 * is covered the day it is written, without anyone remembering this file.
 */

/** Every `@InputType` and `@ArgsType` the console schema reaches, with its fields. */
interface InputClass {
  kind: 'input' | 'args';
  name: string;
  target: new () => object;
  fields: string[];
}

const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

let classes: InputClass[];

beforeAll(async () => {
  // Building the schema is what loads and compiles the metadata for every input
  // class reachable from a resolver — including ones no spec imports.
  await buildConsoleSchema();

  const collect = (kind: InputClass['kind'], entries: readonly { target: unknown; properties?: unknown }[]) =>
    entries.map((entry) => {
      const target = entry.target as new () => object;
      const properties = (entry.properties ?? []) as { name: string }[];
      return { kind, name: target.name, target, fields: properties.map((property) => property.name) };
    });

  classes = [
    ...collect('input', TypeMetadataStorage.getInputTypesMetadata()),
    ...collect('args', TypeMetadataStorage.getArgumentsMetadata()),
  ];
});

/**
 * The pipe's verdict on an object carrying exactly `fields`, reduced to the
 * whitelist refusals. Everything else it says — a string where a date belongs,
 * a number out of range — is the dummy values talking and is not what this
 * file is about.
 */
async function rejectedFields(input: InputClass): Promise<string[]> {
  const value = Object.fromEntries(input.fields.map((field) => [field, 'x']));
  try {
    await pipe.transform(value, { type: 'body', metatype: input.target });
    return [];
  } catch (caught) {
    if (!(caught instanceof BadRequestException)) throw caught;
    const response = caught.getResponse() as { message?: string | string[] };
    const messages = Array.isArray(response.message) ? response.message : [response.message ?? ''];
    return messages.filter((message) => message.includes('should not exist'));
  }
}

describe('every GraphQL input the console can send', () => {
  it('reaches a resolver at all — no field is stripped and then refused', async () => {
    const refused = new Map<string, string[]>();
    for (const input of classes) {
      const messages = await rejectedFields(input);
      if (messages.length > 0) {
        refused.set(`${input.name} (@${input.kind === 'input' ? 'InputType' : 'ArgsType'})`, messages);
      }
    }

    expect(
      Object.fromEntries(refused),
      'An @Field with no class-validator decorator makes every call carrying it a Bad Request, ' +
        'because `whitelist` strips it and `forbidNonWhitelisted` then refuses it. Give the field a ' +
        'validator — @IsString, @IsEnum, @IsOptional — rather than relaxing the pipe.',
    ).toEqual({});
  });

  it('is actually looking at something — the walk found the classes it should have', async () => {
    const names = classes.map((input) => input.name);
    // A sample across the schema: if the metadata walk ever silently returns
    // nothing, the assertion above would pass on an empty set.
    expect(names).toEqual(expect.arrayContaining(['AppendChatMessageInputModel', 'ActivityRangeArgs']));
    expect(classes.length).toBeGreaterThan(10);
    expect(classes.every((input) => input.fields.length > 0)).toBe(true);
  });
});

describe('AppendChatMessageInput, the one that shipped broken', () => {
  it('accepts the role the console sends (SUP-187)', async () => {
    const input = classes.find((candidate) => candidate.name === 'AppendChatMessageInputModel');
    expect(input, 'AppendChatMessageInputModel is no longer in the schema').toBeDefined();

    // GraphQL resolves the `USER` enum literal to its value before the pipe sees
    // it, so this is the exact object the pipe was refusing on every send.
    const accepted = await pipe.transform(
      { workspaceId: 'ws-1', threadId: 'th-1', role: 'user', content: 'Hello.', error: null },
      { type: 'body', metatype: (input as InputClass).target },
    );

    expect(accepted).toMatchObject({ role: 'user', content: 'Hello.' });
  });

  it('still refuses a role that is not one of the two', async () => {
    const input = classes.find((candidate) => candidate.name === 'AppendChatMessageInputModel') as InputClass;
    await expect(
      pipe.transform(
        { workspaceId: 'ws-1', threadId: 'th-1', role: 'system', content: 'Hello.' },
        { type: 'body', metatype: input.target },
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
