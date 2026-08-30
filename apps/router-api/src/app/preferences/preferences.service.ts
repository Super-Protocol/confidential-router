import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { UserPreferences } from '../db/entities/user-preferences.entity.js';

export interface PreferencesInput {
  archiveEvidence?: boolean | null;
  evidenceRetentionDays?: number | null;
  notifyOnMeasurementChange?: boolean | null;
  desktopNotifications?: boolean | null;
  emailReceipts?: boolean | null;
}

/** Bounds on the retention window, in days. */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

/**
 * Console preferences, including the Evidence group.
 *
 * A user who has never changed anything has no row: `get` answers from the
 * entity's own defaults instead of writing one on read, so a sign-in is not a
 * write and the defaults live in exactly one place — the column definitions.
 */
@Injectable()
export class PreferencesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async get(userId: string): Promise<UserPreferences> {
    const stored = await this.dataSource.getRepository(UserPreferences).findOne({ where: { userId } });
    return stored ?? this.defaults(userId);
  }

  async update(userId: string, input: PreferencesInput): Promise<UserPreferences> {
    if (input.evidenceRetentionDays !== undefined && input.evidenceRetentionDays !== null) {
      const days = input.evidenceRetentionDays;
      if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
        throw new BadRequestException(
          `The evidence retention window must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days.`,
        );
      }
    }

    const current = await this.get(userId);
    const updated = this.dataSource.getRepository(UserPreferences).create({
      ...current,
      // `undefined` means "not in this request"; `null` is not a value any of
      // these fields accepts, so both leave the stored setting alone.
      archiveEvidence: input.archiveEvidence ?? current.archiveEvidence,
      evidenceRetentionDays: input.evidenceRetentionDays ?? current.evidenceRetentionDays,
      notifyOnMeasurementChange: input.notifyOnMeasurementChange ?? current.notifyOnMeasurementChange,
      desktopNotifications: input.desktopNotifications ?? current.desktopNotifications,
      emailReceipts: input.emailReceipts ?? current.emailReceipts,
      userId,
      updatedAt: new Date(),
    });
    await this.dataSource.getRepository(UserPreferences).save(updated);
    return updated;
  }

  private defaults(userId: string): UserPreferences {
    return this.dataSource.getRepository(UserPreferences).create({
      userId,
      archiveEvidence: true,
      evidenceRetentionDays: 90,
      notifyOnMeasurementChange: true,
      desktopNotifications: false,
      emailReceipts: true,
      updatedAt: new Date(0),
    });
  }
}
