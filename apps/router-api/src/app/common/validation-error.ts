import { BadRequestException, HttpException } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

/**
 * What the global `ValidationPipe` throws, and how a client reads it back.
 *
 * Nest's own exception factory puts every constraint message in a `message`
 * array and nothing else. That array survives as far as the GraphQL layer and no
 * further: `formatConsoleError` drops `extensions.originalError` in production —
 * it is where Apollo parks the whole exception and its stack — and what the
 * client is left with is `HttpException.message`, which for a response object is
 * the literal string "Bad Request Exception".
 *
 * So the console could not say which field it had got wrong, and every refusal
 * looked the same as a connection failure (SUP-295 item 2). The fix is to carry
 * the per-field map beside the array the pipe already produces, so the dialog
 * can put the message under the input it belongs to.
 */
export interface ValidationFailure {
  /** Every constraint message, as Nest's own factory flattens them. */
  messages: string[];
  /** The first message per field, keyed by the input property it is about. */
  fields: Record<string, string>;
}

/** Response body of a validation refusal: Nest's shape, plus {@link ValidationFailure.fields}. */
interface ValidationResponse {
  statusCode: number;
  error: string;
  message: string[];
  fields: Record<string, string>;
}

/**
 * The exception the pipe throws for a refused input.
 *
 * `message` keeps exactly the array Nest would have produced — it is what the
 * REST surface answers with, and what `input-validation.spec.ts` reads to find a
 * field the whitelist stripped.
 */
export function validationException(errors: ValidationError[]): BadRequestException {
  const failure = failureOf(errors);
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: failure.messages,
    fields: failure.fields,
  } satisfies ValidationResponse);
}

/** The whole tree flattened, parent-first, the way Nest orders it. */
function failureOf(errors: ValidationError[], parent = ''): ValidationFailure {
  const messages: string[] = [];
  const fields: Record<string, string> = {};

  for (const error of errors) {
    const path = parent ? `${parent}.${error.property}` : error.property;
    for (const message of Object.values(error.constraints ?? {})) {
      messages.push(message);
      // The first message wins: a field with two broken constraints has one
      // place to show one of them, and the first is the one the pipe reports.
      fields[path] ??= message;
    }
    if (error.children?.length) {
      const nested = failureOf(error.children, path);
      messages.push(...nested.messages);
      Object.assign(fields, nested.fields);
    }
  }

  return { messages, fields };
}

/**
 * Reads a validation refusal back out of a thrown exception, or null when it is
 * not one.
 *
 * Deliberately shape-based rather than `instanceof`: the exception crosses the
 * GraphQL layer wrapped, and what survives is the response body.
 */
export function validationFailureOf(error: unknown): ValidationFailure | null {
  if (!(error instanceof HttpException)) {
    return null;
  }
  const response = error.getResponse();
  if (typeof response !== 'object' || response === null) {
    return null;
  }
  const { message, fields } = response as Partial<ValidationResponse>;
  if (!Array.isArray(message) || message.length === 0) {
    return null;
  }
  return {
    messages: message.filter((entry): entry is string => typeof entry === 'string'),
    fields: typeof fields === 'object' && fields !== null ? fields : {},
  };
}
