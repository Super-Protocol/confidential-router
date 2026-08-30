import { BadRequestException } from '@nestjs/common';

/**
 * Opaque keyset cursors.
 *
 * Keyset and not `OFFSET`: the log is append-heavy, and an offset page shifts
 * under the reader every time a generation lands. The cursor carries the sort
 * value and the row id, which together are unique, so a page boundary is stable
 * whatever arrives in the meantime.
 */
export interface Cursor {
  /** The value of the column being sorted on. */
  value: number;
  /** Tie-breaker, so two rows with the same value still have a total order. */
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.value, cursor.id]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Malformed cursor.');
  }
  if (!Array.isArray(parsed) || typeof parsed[0] !== 'number' || typeof parsed[1] !== 'string') {
    throw new BadRequestException('Malformed cursor.');
  }
  return { value: parsed[0], id: parsed[1] };
}
