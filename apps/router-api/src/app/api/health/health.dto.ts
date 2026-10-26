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

export class AlertsHealthDto {
  @ApiProperty({
    enum: ['disabled', 'unconfigured', 'ready', 'ok', 'failing'],
    description:
      'Whether an outage alert can leave this deployment (SUP-535). `disabled`: `alerts.email` is off or there is ' +
      'no mail provider. `unconfigured`: enabled with nobody to write to — neither `alerts.emails` nor ' +
      '`auth.adminEmails` names an address, which is the state that looks exactly like “quiet”. `ready`: nothing ' +
      'has been raised yet. `ok` / `failing`: whether the last alert reached anybody.',
  })
  state!: 'disabled' | 'unconfigured' | 'ready' | 'ok' | 'failing';

  @ApiProperty({ description: 'How many addresses an alert would go to. The addresses themselves are never reported.' })
  recipients!: number;

  @ApiProperty({ required: false, description: 'When an alert was last attempted. Absent until there has been one.' })
  lastAttemptAt?: string;

  @ApiProperty({
    required: false,
    description: 'Alerts held back by `alerts.minInterval` since the last message that went out.',
  })
  suppressed?: number;
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

  @ApiProperty({
    type: () => AlertsHealthDto,
    description:
      'Whether the outage alert above has an outbound path. Reported only; never makes the status `error` — a ' +
      'deployment that cannot alert still serves every model. `externalEndpoints.status: outage` beside ' +
      '`alerts.state: unconfigured` is the pair that says nobody has been told.',
  })
  alerts!: AlertsHealthDto;
}
