import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';
import type { GenerationStatus } from '../db/entities/generation.entity.js';

/** `?modelIds=a,b` and `?modelIds=a&modelIds=b` both mean the same list. */
const toList = ({ value }: { value: unknown }): string[] | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const values = Array.isArray(value) ? value : String(value).split(',');
  return values.map((entry) => String(entry).trim()).filter(Boolean);
};

export class GenerationCsvQueryDto {
  @IsString()
  workspaceId!: string;

  @ApiPropertyOptional({ description: 'Inclusive start of the range, ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Exclusive end of the range, ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Comma-separated model ids.' })
  @IsOptional()
  @Transform(toList)
  @IsString({ each: true })
  modelIds?: string[];

  @ApiPropertyOptional({ description: 'Comma-separated API key ids.' })
  @IsOptional()
  @Transform(toList)
  @IsString({ each: true })
  apiKeyIds?: string[];

  @ApiPropertyOptional({ enum: ['ok', 'error', 'aborted'], isArray: true })
  @IsOptional()
  @Transform(toList)
  @IsIn(['ok', 'error', 'aborted'], { each: true })
  status?: GenerationStatus[];
}
