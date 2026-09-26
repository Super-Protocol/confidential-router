import { Transform } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';
import { MAX_DEMAND_ROWS } from './model-requests.service.js';

export class ModelDemandCsvQueryDto {
  /** Inclusive start, ISO-8601. Omit for every request ever filed. */
  @IsOptional()
  @IsISO8601()
  since?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(MAX_DEMAND_ROWS)
  limit?: number;
}
