import { BadRequestException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource } from '../../../test/seed.js';
import { UserPreferences } from '../db/entities/user-preferences.entity.js';
import { PreferencesService } from './preferences.service.js';

const USER = 'user-1';

let dataSource: DataSource;
let preferences: PreferencesService;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  preferences = new PreferencesService(dataSource);
});

afterEach(async () => {
  await dataSource.destroy();
});

describe('reading', () => {
  it('answers with the defaults for a user who has never changed anything', async () => {
    expect(await preferences.get(USER)).toMatchObject({
      archiveEvidence: true,
      evidenceRetentionDays: 90,
      notifyOnMeasurementChange: true,
      desktopNotifications: false,
      emailReceipts: true,
    });
  });

  it('does not write a row just because someone looked', async () => {
    await preferences.get(USER);

    expect(await dataSource.getRepository(UserPreferences).count()).toBe(0);
  });
});

describe('updating', () => {
  it('stores the settings named and leaves the rest alone', async () => {
    await preferences.update(USER, { archiveEvidence: false });
    const updated = await preferences.update(USER, { evidenceRetentionDays: 365 });

    expect(updated).toMatchObject({ archiveEvidence: false, evidenceRetentionDays: 365, emailReceipts: true });
  });

  it('keeps one row per user however often it is written', async () => {
    await preferences.update(USER, { desktopNotifications: true });
    await preferences.update(USER, { desktopNotifications: false });

    expect(await dataSource.getRepository(UserPreferences).count()).toBe(1);
  });

  it('rejects a retention window outside its bounds', async () => {
    for (const days of [0, -1, 4_000, 1.5]) {
      await expect(preferences.update(USER, { evidenceRetentionDays: days })).rejects.toThrow(BadRequestException);
    }
  });

  it('keeps users apart', async () => {
    await preferences.update(USER, { emailReceipts: false });

    expect((await preferences.get('user-2')).emailReceipts).toBe(true);
  });
});
