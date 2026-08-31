import { ArgsType, Field, GraphQLISODateTime, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import { IsBoolean, IsDate, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import type { UserPreferences } from '../../../db/entities/user-preferences.entity.js';

@ObjectType('UserPreferences', { description: 'Console settings, including the Evidence group.' })
export class UserPreferencesModel {
  @Field(() => Boolean, { description: 'Keep the published bundle and JWS, not just the digests.' })
  archiveEvidence!: boolean;

  @Field(() => Int, { description: 'How long archived bundles are kept, in days. Digests are kept forever.' })
  evidenceRetentionDays!: number;

  @Field(() => Boolean, { description: 'Notify when an endpoint publishes different measurements.' })
  notifyOnMeasurementChange!: boolean;

  @Field(() => Boolean)
  desktopNotifications!: boolean;

  @Field(() => Boolean)
  emailReceipts!: boolean;
}

@InputType('UpdatePreferencesInput')
export class UpdatePreferencesInput {
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  archiveEvidence?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  evidenceRetentionDays?: number;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  notifyOnMeasurementChange?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  desktopNotifications?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  emailReceipts?: boolean;
}

@ObjectType('EvidenceExport', { description: 'An expiring link to a zip of what the endpoints published.' })
export class EvidenceExportModel {
  @Field(() => String)
  url!: string;

  @Field(() => GraphQLISODateTime)
  expiresAt!: Date;
}

@ArgsType()
export class ExportEvidenceArgs {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @Field(() => GraphQLISODateTime)
  @IsDate()
  from!: Date;

  @Field(() => GraphQLISODateTime)
  @IsDate()
  to!: Date;
}

/**
 * Projection of the stored row, shared by the `updatePreferences` mutation and
 * the `me.preferences` field so the two cannot answer differently.
 */
export function preferencesModel(preferences: UserPreferences): UserPreferencesModel {
  return {
    archiveEvidence: preferences.archiveEvidence,
    evidenceRetentionDays: preferences.evidenceRetentionDays,
    notifyOnMeasurementChange: preferences.notifyOnMeasurementChange,
    desktopNotifications: preferences.desktopNotifications,
    emailReceipts: preferences.emailReceipts,
  };
}
