import { afterEach, describe, expect, it } from 'vitest';
import { inviteCodesCsvUrl } from './invite-codes-csv';
import { PUBLIC_CONFIG_GLOBAL } from './public-config';

const injected = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
  delete injected[PUBLIC_CONFIG_GLOBAL];
});

describe('inviteCodesCsvUrl', () => {
  it('asks for every code when nothing is filtered', () => {
    const url = new URL(inviteCodesCsvUrl());

    expect(url.pathname).toBe('/admin/invite-codes/export.csv');
    expect(url.search).toBe('');
  });

  it('carries the campaign, and the status in the casing the REST route validates', () => {
    const url = new URL(inviteCodesCsvUrl({ campaign: 'launch-2026-10', status: 'WITHDRAWN' }));

    expect(url.searchParams.get('campaign')).toBe('launch-2026-10');
    expect(url.searchParams.get('status')).toBe('withdrawn');
  });

  it('follows the origin the page was configured with', () => {
    injected[PUBLIC_CONFIG_GLOBAL] = {
      apiOrigin: 'https://api.example.com',
      graphqlHttp: 'https://api.example.com/graphql',
      authCallbackUrl: '/',
      swarmRootPemUrl: 'https://landing.example.com/swarm-root.pem',
    };

    expect(new URL(inviteCodesCsvUrl()).origin).toBe('https://api.example.com');
  });
});
