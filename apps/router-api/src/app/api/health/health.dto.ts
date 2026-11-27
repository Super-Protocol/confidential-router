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
    enum: ['unreachable', 'auth_failed', 'error'],
    description:
      'Present only while failing. `unreachable`: the mail server could not be connected to at all. A message ' +
      'the server refused is not reported here — that is one address, not the mailer, and it stays in the log.',
  })
  reason?: 'unreachable' | 'auth_failed' | 'error';

  @ApiProperty({ required: false, description: 'When `state` was last established.' })
  since?: string;

  @ApiProperty({
    enum: ['invite_only', 'open'],
    description:
      'Whether this deployment withholds sign-up mail. `invite_only`: an address with no invitation is mailed ' +
      'nothing and the send route answers it exactly as it answers a send (SUP-410), so a healthy `state` here ' +
      'does not mean any particular request was delivered — look at `mailDelivery` on the console API for the ' +
      'withheld count. Deployment configuration rather than an event, and the same fact the public ' +
      '`signInOptions.inviteRequired` already reports, so it tells a caller nothing new about any address.',
  })
  signUpGate!: 'invite_only' | 'open';

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
      'Registered external upstreams, in one word. `none`: no external model is registered here, so there is ' +
      'nothing to serve. `unknown`: no status pass has completed, so this router cannot say. `ok`: all serving. ' +
      '`degraded`: one or more is not, below the outage thresholds — or this deployment can route to none of its ' +
      'models and has not been that way for long. `outage`: a run has passed `externalEndpoints.outage.*`, or ' +
      'the catalogue has been short of the rows for two passes, or this deployment has advertised models it ' +
      'routes to none of for longer than `outage.afterNoSuccess` (SUP-879) — the value to alert on.',
  })
  status!: 'none' | 'unknown' | 'ok' | 'degraded' | 'outage';

  @ApiProperty({ description: 'Enabled upstreams. One an operator disabled is out of service and counted nowhere.' })
  registered!: number;

  @ApiProperty({
    description:
      'Holding an admitting verdict right now, as of the last pass — the stored rows’ answer, not a promise ' +
      'about `/v1`. Compare `routable`.',
  })
  serving!: number;

  @ApiProperty({
    description:
      'How many enabled upstreams the catalogue the gateway resolves against will actually route to — ' +
      'admission’s own answer, derived independently of the rows’ and in the same unit, so the two are meant ' +
      'to be equal. `routable` below `serving` means a model whose row says it is admitted is being refused ' +
      'with a 503 `attestation_failed`. The two come from two reads one pass apart, so a single disagreeing ' +
      'pass can be a write that landed between them; `status` becomes `outage` only once a second ' +
      'consecutive pass is still short. Recovery: cycle the endpoint, or restart the pod.',
  })
  routable!: number;

  @ApiProperty({ description: 'Denied by the last check: this router looked and refused.' })
  failing!: number;

  @ApiProperty({ description: 'Of `failing`, those whose last check never got a document back at all.' })
  unreachable!: number;

  @ApiProperty({ description: 'Checked, neither admitted nor denied: awaiting a first check or an admin’s approval.' })
  pending!: number;

  @ApiProperty({
    description:
      'Registered endpoints an operator’s switch is off on — the rows `registered` and every count beside it ' +
      'are blind to. A rebuilt deployment holds all of its upstreams here until they are re-keyed, which is ' +
      'the state this document used to report as `none`.',
  })
  disabled!: number;

  @ApiProperty({
    description:
      'Registered endpoints holding no upstream API key at all: the step an operator still owes. A data import ' +
      'lands every external endpoint here, because the export bundle carries no secrets — rotate the key under ' +
      'Administration → External endpoints and enable the endpoint.',
  })
  awaitingKey!: number;

  @ApiProperty({
    description:
      'Enabled external models registered here, routable or not, including those whose endpoint is switched ' +
      'off. The denominator for every count above: zero routable upstreams is nothing to report when this is ' +
      '0, and a dark `/v1` when it is not.',
  })
  models!: number;

  @ApiProperty({
    description: 'Of `models`, the ones `GET /v1/models` lists right now — the catalogue’s answer in models.',
  })
  routableModels!: number;

  @ApiProperty({
    required: false,
    description:
      'When the longest-running outstanding “not serving” began — a single upstream’s run, or, on a deployment ' +
      'whose endpoints are all switched off, when this process first found nothing routable. Absent when every ' +
      'upstream is serving.',
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

  @ApiProperty({
    type: () => EvidenceRetentionHealthDto,
    description: 'Reported only; never makes the status `error`.',
  })
  evidenceRetention!: EvidenceRetentionHealthDto;
}
