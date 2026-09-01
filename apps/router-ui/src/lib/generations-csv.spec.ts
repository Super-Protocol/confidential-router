import { afterEach, describe, expect, it } from 'vitest';
import { generationsCsvUrl } from './generations-csv';
import { PUBLIC_CONFIG_GLOBAL } from './public-config';

const injected = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
  delete injected[PUBLIC_CONFIG_GLOBAL];
});

describe('generationsCsvUrl', () => {
  it('always carries the workspace', () => {
    const url = new URL(generationsCsvUrl({ workspaceId: 'ws-1' }));

    expect(url.pathname).toBe('/activity/generations.csv');
    expect(url.searchParams.get('workspaceId')).toBe('ws-1');
  });

  // A literal origin, not `publicConfig().apiOrigin`: comparing the result to the
  // same source it was built from would pass however the link was assembled.
  // The download has to follow the origin *this page* was configured with — the
  // export is a browser navigation, so a stale host is a 404 the viewer sees.
  it('follows the origin the page was configured with, not one fixed at build time', () => {
    injected[PUBLIC_CONFIG_GLOBAL] = {
      apiOrigin: 'https://api.example.com',
      graphqlHttp: 'https://api.example.com/graphql',
      authCallbackUrl: '/',
    };

    expect(new URL(generationsCsvUrl({ workspaceId: 'ws-1' })).origin).toBe('https://api.example.com');
  });

  it('omits every filter that is not set, so the export is not narrowed by accident', () => {
    const url = new URL(generationsCsvUrl({ workspaceId: 'ws-1', modelIds: [], apiKeyIds: [], statuses: [] }));

    expect([...url.searchParams.keys()]).toEqual(['workspaceId']);
  });

  it('sends the filters as the REST DTO reads them: comma-separated, status lower-case', () => {
    const url = new URL(
      generationsCsvUrl({
        workspaceId: 'ws-1',
        from: '2026-08-30T12:00:00.000Z',
        to: '2026-08-31T12:00:00.000Z',
        modelIds: ['meta/llama-3.3-70b-instruct:tdx'],
        apiKeyIds: ['key-1', 'key-2'],
        statuses: ['OK', 'ERROR'],
      }),
    );

    expect(url.searchParams.get('from')).toBe('2026-08-30T12:00:00.000Z');
    expect(url.searchParams.get('to')).toBe('2026-08-31T12:00:00.000Z');
    expect(url.searchParams.get('modelIds')).toBe('meta/llama-3.3-70b-instruct:tdx');
    expect(url.searchParams.get('apiKeyIds')).toBe('key-1,key-2');
    expect(url.searchParams.get('status')).toBe('ok,error');
  });
});
