import { ApiProperty } from '@nestjs/swagger';

export class HealthCheckDto {
  @ApiProperty({ enum: ['up', 'down'] })
  status!: 'up' | 'down';

  @ApiProperty({ required: false, description: 'Present only when the check failed.' })
  error?: string;
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

export class EvidenceRetentionHealthDto {
  @ApiProperty({
    enum: ['enabled', 'disabled'],
    description:
      'Whether this process has a retention sweep scheduled. `disabled`: `evidence.retentionSweepInterval` ' +
      'is 0, so archived evidence bundles are kept past the period `/privacy` publishes.',
  })
  status!: 'enabled' | 'disabled';

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'When the last pass finished. Null until the first one has, which is within seconds of boot.',
  })
  lastSweepAt!: string | null;

  @ApiProperty({
    description:
      'Snapshots whose bundle and JWS this process removed since boot; the digests are kept. ' +
      'Monotonic; read it twice and subtract.',
  })
  stripped!: number;

  @ApiProperty({ description: 'Passes that ended in an error since boot. A pass that throws is retried, not fatal.' })
  failed!: number;
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

  @ApiProperty({
    type: () => EvidenceRetentionHealthDto,
    description: 'Reported only; never makes the status `error`.',
  })
  evidenceRetention!: EvidenceRetentionHealthDto;
}
