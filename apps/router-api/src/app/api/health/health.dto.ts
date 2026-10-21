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
    enum: ['unreachable', 'auth_failed', 'error'],
    description:
      'Present only while failing. `unreachable`: the mail server could not be connected to at all. A message ' +
      'the server refused is not reported here — that is one address, not the mailer, and it stays in the log.',
  })
  reason?: 'unreachable' | 'auth_failed' | 'error';

  @ApiProperty({ required: false, description: 'When `state` was last established.' })
  since?: string;
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
