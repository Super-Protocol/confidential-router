import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type {
  AuthenticatedRequest,
  SessionUser,
  UserProfileService,
  WorkspaceScopeService,
} from '../../../auth/index.js';
import type { UserPreferences } from '../../../db/entities/user-preferences.entity.js';
import type { PreferencesService } from '../../../preferences/index.js';
import { ViewerResolver } from './viewer.resolver.js';

const USER: SessionUser = { id: 'user-1', email: 'dev@example.test', name: 'Dev', image: 'https://cdn/avatar.png' };

const MEMBERSHIPS = [
  {
    workspace: { id: 'ws-1', name: 'Default', slug: 'default', balanceMicros: 170_650_000 },
    role: 'owner',
  },
  {
    workspace: { id: 'ws-2', name: 'Evaluation', slug: 'evaluation', balanceMicros: 0 },
    role: 'member',
  },
];

function build(
  overrides: {
    workspaces?: Partial<WorkspaceScopeService>;
    preferences?: Partial<PreferencesService>;
    profiles?: Partial<UserProfileService>;
  } = {},
) {
  return new ViewerResolver(
    {
      listForUser: vi.fn().mockResolvedValue(MEMBERSHIPS),
      ...overrides.workspaces,
    } as unknown as WorkspaceScopeService,
    { get: vi.fn(), ...overrides.preferences } as unknown as PreferencesService,
    { require: vi.fn(), rename: vi.fn(), ...overrides.profiles } as unknown as UserProfileService,
  );
}

describe('ViewerResolver.me', () => {
  it('answers with the identity from the session and the workspaces from the membership table', async () => {
    const viewer = await build().me(USER);

    expect(viewer).toMatchObject({ id: 'user-1', email: 'dev@example.test', avatarUrl: 'https://cdn/avatar.png' });
    expect(viewer.workspaces).toEqual([
      { id: 'ws-1', name: 'Default', slug: 'default', role: 'owner', balanceMicros: '170650000' },
      { id: 'ws-2', name: 'Evaluation', slug: 'evaluation', role: 'member', balanceMicros: '0' },
    ]);
  });

  it('carries the balance as a string, so no client rounds a micro away', async () => {
    const workspaces = {
      listForUser: vi
        .fn()
        .mockResolvedValue([
          { workspace: { id: 'ws', name: 'W', slug: 'w', balanceMicros: 9_007_199_254_740_991 }, role: 'owner' },
        ]),
    };

    const viewer = await build({ workspaces }).me(USER);

    expect(viewer.workspaces[0].balanceMicros).toBe('9007199254740991');
  });
});

describe('ViewerResolver field resolvers', () => {
  it('reads createdAt from the row Better Auth owns, not from the session', async () => {
    const require_ = vi.fn().mockResolvedValue({ createdAt: new Date('2026-01-02T03:04:05.000Z') });

    const createdAt = await build({ profiles: { require: require_ } }).createdAt({ id: 'user-1' } as never);

    expect(require_).toHaveBeenCalledWith('user-1');
    expect(createdAt).toEqual(new Date('2026-01-02T03:04:05.000Z'));
  });

  it('resolves preferences for the viewer it is asked about', async () => {
    const stored = {
      archiveEvidence: false,
      evidenceRetentionDays: 365,
      notifyOnMeasurementChange: true,
      desktopNotifications: false,
      emailReceipts: true,
    } as UserPreferences;
    const get = vi.fn().mockResolvedValue(stored);

    const preferences = await build({ preferences: { get } }).preferences({ id: 'user-1' } as never);

    expect(get).toHaveBeenCalledWith('user-1');
    expect(preferences).toEqual({
      archiveEvidence: false,
      evidenceRetentionDays: 365,
      notifyOnMeasurementChange: true,
      desktopNotifications: false,
      emailReceipts: true,
    });
  });
});

describe('ViewerResolver.updateProfile', () => {
  it('renames with the caller’s own headers, and re-reads the workspaces', async () => {
    const headers: IncomingHttpHeaders = { cookie: 'cr_session=abc' };
    const rename = vi.fn().mockResolvedValue({ ...USER, name: 'Renamed' });

    const viewer = await build({ profiles: { rename } }).updateProfile({ headers } as AuthenticatedRequest, {
      name: 'Renamed',
    });

    // The headers, not a user id from the resolver: a caller must not be able to
    // rename an account other than the one their cookie proves.
    expect(rename).toHaveBeenCalledWith(headers, 'Renamed');
    expect(viewer.name).toBe('Renamed');
    expect(viewer.workspaces).toHaveLength(2);
  });
});
