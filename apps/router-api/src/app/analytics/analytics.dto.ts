import { CONSOLE_INGEST_EVENTS } from '@confidential-router/types';
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * What the console may post to the first-party ingest.
 *
 * Deliberately thin. `distinct_id`, `timestamp` and `uuid` are the server's to
 * decide — a client that could choose them could attribute an event to another
 * account, date it into last quarter, or overwrite one that already landed.
 *
 * `event` is validated as a string here and against `CONSOLE_INGEST_EVENTS` in the
 * controller rather than with `@IsIn`, so the one rejection a console developer
 * will ever see names the event; `properties` is checked against the taxonomy's
 * allow-list for that event, also in the controller, because which names are legal
 * depends on which event this is.
 */
export class ConsoleEventDto {
  @ApiProperty({
    enum: CONSOLE_INGEST_EVENTS,
    description: 'The event. Only the two the browser is allowed to assert (ADR-006 §3).',
  })
  @IsString()
  @IsNotEmpty()
  event!: string;

  @ApiProperty({
    required: false,
    additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
    description: 'Scalars only, and only the names the taxonomy declares for this event. Anything else is dropped.',
  })
  @IsOptional()
  @IsObject()
  properties?: Record<string, unknown>;
}
