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
}
