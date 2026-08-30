import { ApiProperty } from '@nestjs/swagger';

export class HealthCheckDto {
  @ApiProperty({ enum: ['up', 'down'] })
  status!: 'up' | 'down';

  @ApiProperty({ required: false, description: 'Present only when the check failed.' })
  error?: string;
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
}
