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

export class ExternalEndpointsHealthDto {
  @ApiProperty({
    enum: ['none', 'unknown', 'ok', 'degraded', 'outage'],
    description:
      'Registered external upstreams, in one word. `none`: nothing registered. `unknown`: no status pass has ' +
      'completed, so this router cannot say. `ok`: all serving. `degraded`: one or more is not, below the outage ' +
      'thresholds. `outage`: a run has passed `externalEndpoints.outage.*` — the value to alert on.',
  })
  status!: 'none' | 'unknown' | 'ok' | 'degraded' | 'outage';

  @ApiProperty({ description: 'Enabled upstreams. One an operator disabled is out of service and counted nowhere.' })
  registered!: number;

  @ApiProperty({ description: 'Holding an admitting verdict right now — what the catalogue will route to.' })
  serving!: number;

  @ApiProperty({ description: 'Denied by the last check: this router looked and refused.' })
  failing!: number;

  @ApiProperty({ description: 'Of `failing`, those whose last check never got a document back at all.' })
  unreachable!: number;

  @ApiProperty({ description: 'Checked, neither admitted nor denied: awaiting a first check or an admin’s approval.' })
  pending!: number;

  @ApiProperty({
    required: false,
    description: 'When the longest-running outstanding “not serving” began. Absent when every upstream is serving.',
  })
  since?: string;

  @ApiProperty({
    required: false,
    description:
      'When the sidecar’s verdicts were last read back. A timestamp that has stopped moving says the counts are ' +
      'stale — the one failure the counts cannot show by themselves. Absent until the first pass.',
  })
  verdictsReadAt?: string;
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
    type: () => ExternalEndpointsHealthDto,
    description: 'Reported only; never makes the status `error`. Counts, never endpoint identity.',
  })
  externalEndpoints!: ExternalEndpointsHealthDto;
}
