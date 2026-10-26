import { ApiProperty } from '@nestjs/swagger';

export class HealthCheckDto {
  @ApiProperty({ enum: ['up', 'down'] })
  status!: 'up' | 'down';

  @ApiProperty({ required: false, description: 'Present only when the check failed.' })
  error?: string;
}

export class UndeliverableMailDto {
  @ApiProperty({
    description:
      'Addresses this deployment’s mail provider is dropping messages to — a hard bounce, a spam complaint, or ' +
      'its suppression list. A send to one of them succeeds and is then discarded, so it appears nowhere else.',
  })
  addresses!: number;

  @ApiProperty({
    required: false,
    description: 'When the most recent of those was reported. Absent while there are none.',
  })
  lastAt?: string;
}

export class MailHealthDto {
  @ApiProperty({ enum: ['none', 'console', 'resend', 'smtp'] })
  provider!: 'none' | 'console' | 'resend' | 'smtp';

  @ApiProperty({
    enum: ['disabled', 'unverified', 'ok', 'failing'],
    description: 'From the boot-time check or the most recent send, whichever is later.',
  })
  state!: 'disabled' | 'unverified' | 'ok' | 'failing';

  @ApiProperty({
    required: false,
    enum: ['unreachable', 'auth_failed', 'rejected', 'error'],
    description: 'Present only while failing. `unreachable`: the mail server could not be connected to at all.',
  })
  reason?: 'unreachable' | 'auth_failed' | 'rejected' | 'error';

  @ApiProperty({ required: false, description: 'When `state` was last established.' })
  since?: string;

  @ApiProperty({
    type: () => UndeliverableMailDto,
    description:
      'What the provider reported after it accepted a message (SUP-551). Independent of `state`, which only ever ' +
      'knows whether the hand-off to the provider worked.',
  })
  undeliverable!: UndeliverableMailDto;
}

export class AnalyticsHealthDto {
  @ApiProperty({
    enum: ['configured', 'disabled'],
    description:
      'Which sink this process built. `disabled`: no `POSTHOG_PROJECT_KEY`, so every product event is discarded.',
  })
  status!: 'configured' | 'disabled';

  @ApiProperty({
    description:
      'Events lost since this process started — discarded by the disabled sink, refused by PostHog or ' +
      'undeliverable. Monotonic; read it twice and subtract.',
  })
  dropped!: number;
}

export class HealthResponseDto {
  @ApiProperty({ enum: ['ok', 'error'] })
  status!: 'ok' | 'error';

  @ApiProperty({ example: '0.0.1' })
  version!: string;

  @ApiProperty({ description: 'Process uptime in seconds.' })
  uptimeSeconds!: number;

  @ApiProperty({ type: () => HealthCheckDto })
  database!: HealthCheckDto;

  @ApiProperty({ type: () => MailHealthDto, description: 'Reported only; never makes the status `error`.' })
  mail!: MailHealthDto;

  @ApiProperty({ type: () => AnalyticsHealthDto, description: 'Reported only; never makes the status `error`.' })
  analytics!: AnalyticsHealthDto;
}
