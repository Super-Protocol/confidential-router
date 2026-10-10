import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import type { InviteCodeStatus } from '../../invites/index.js';

/** The Codes tab's two filters, as the export's query string. Both optional: no filter is every code. */
export class InviteCodesExportQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 64)
  campaign?: string;

  @IsOptional()
  @IsIn(['active', 'redeemed', 'expired', 'withdrawn'])
  status?: InviteCodeStatus;
}

/** `apply=true&expect=<sha256>` to import; neither for the dry run. */
export class InviteCodesImportQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  apply?: string;

  @IsOptional()
  @IsString()
  @Length(64, 64)
  expect?: string;
}
