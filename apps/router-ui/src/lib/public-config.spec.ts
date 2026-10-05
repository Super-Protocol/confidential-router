import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_API_ORIGIN,
  DEFAULT_SWARM_ROOT_PEM_URL,
  PUBLIC_CONFIG_GLOBAL,
  type PublicConfig,
  publicConfig,
  publicConfigScript,
  readPublicConfig,
} from './public-config';

const injected = globalThis as unknown as Record<string, unknown>;

function inject(config: unknown): void {
  injected[PUBLIC_CONFIG_GLOBAL] = config;
}

afterEach(() => {
  delete injected[PUBLIC_CONFIG_GLOBAL];
});

describe('readPublicConfig', () => {
  it('derives the GraphQL endpoint from the API origin, so a deployment sets one variable', () => {
    expect(readPublicConfig({ ROUTER_UI_API_ORIGIN: 'https://api.example.com' })).toEqual({
      apiOrigin: 'https://api.example.com',
      graphqlHttp: 'https://api.example.com/graphql',
      authCallbackUrl: '/',
      swarmRootPemUrl: DEFAULT_SWARM_ROOT_PEM_URL,
    });
  });

  it('trims a trailing slash, so a hostname pasted from a browser bar does not double it', () => {
    const config = readPublicConfig({ ROUTER_UI_API_ORIGIN: 'https://api.example.com/' });

    expect(config.apiOrigin).toBe('https://api.example.com');
    expect(config.graphqlHttp).toBe('https://api.example.com/graphql');
  });

  it('lets a deployment put GraphQL and the sign-in callback somewhere else', () => {
    expect(
      readPublicConfig({
        ROUTER_UI_API_ORIGIN: 'https://api.example.com',
        ROUTER_UI_GRAPHQL_HTTP: 'https://gql.example.com/query',
        ROUTER_UI_AUTH_CALLBACK_URL: '/models',
        ROUTER_UI_SWARM_ROOT_PEM_URL: 'https://stand.example.com/swarm-root.pem',
      }),
    ).toEqual({
      apiOrigin: 'https://api.example.com',
      graphqlHttp: 'https://gql.example.com/query',
      authCallbackUrl: '/models',
      swarmRootPemUrl: 'https://stand.example.com/swarm-root.pem',
    });
  });

  it('treats an empty or blank variable as unset — a chart that renders "" must not break the console', () => {
    expect(
      readPublicConfig({ ROUTER_UI_API_ORIGIN: '  ', ROUTER_UI_GRAPHQL_HTTP: '', ROUTER_UI_SWARM_ROOT_PEM_URL: ' ' }),
    ).toEqual({
      apiOrigin: DEFAULT_API_ORIGIN,
      graphqlHttp: `${DEFAULT_API_ORIGIN}/graphql`,
      authCallbackUrl: '/',
      swarmRootPemUrl: DEFAULT_SWARM_ROOT_PEM_URL,
    });
  });
});

describe('publicConfig', () => {
  it('reads what the document injected', () => {
    const config: PublicConfig = {
      apiOrigin: 'https://one.example.com',
      graphqlHttp: 'https://one.example.com/graphql',
      authCallbackUrl: '/',
      swarmRootPemUrl: 'https://one.example.com/swarm-root.pem',
    };
    inject(config);

    expect(publicConfig()).toEqual(config);
  });

  it('reflects a second injection, because nothing caches the first', () => {
    inject({
      apiOrigin: 'https://one.example.com',
      graphqlHttp: 'https://one.example.com/graphql',
      authCallbackUrl: '/',
      swarmRootPemUrl: DEFAULT_SWARM_ROOT_PEM_URL,
    });
    expect(publicConfig().apiOrigin).toBe('https://one.example.com');

    inject({
      apiOrigin: 'https://two.example.com',
      graphqlHttp: 'https://two.example.com/graphql',
      authCallbackUrl: '/',
      swarmRootPemUrl: DEFAULT_SWARM_ROOT_PEM_URL,
    });
    expect(publicConfig().apiOrigin).toBe('https://two.example.com');
  });

  it('falls back to the environment when the document carried nothing usable', () => {
    inject({ apiOrigin: 'https://one.example.com' });

    expect(publicConfig().apiOrigin).toBe(DEFAULT_API_ORIGIN);
  });
});

describe('swarmRootPemUrl', () => {
  // The URL lands in a `gatekeeper trust roots add` line the reader pastes
  // (SUP-193), so a deployment that publishes the CA elsewhere has to be able to
  // say so at run time — exactly like the API origin it sits beside.
  it('is a real URL by default, because a placeholder there is a command nobody can run', () => {
    expect(readPublicConfig({}).swarmRootPemUrl).toBe(DEFAULT_SWARM_ROOT_PEM_URL);
    expect(DEFAULT_SWARM_ROOT_PEM_URL).toMatch(/^https:\/\/[^<>]+\.pem$/);
  });

  it('does not come from the API origin — a root served by the endpoint it vouches for proves nothing', () => {
    const config = readPublicConfig({ ROUTER_UI_API_ORIGIN: 'https://api.example.com' });

    expect(config.swarmRootPemUrl.startsWith(config.apiOrigin)).toBe(false);
  });
});

describe('publicConfigScript', () => {
  it('round-trips through a script tag', () => {
    const config = readPublicConfig({ ROUTER_UI_API_ORIGIN: 'https://api.example.com' });

    // `new Function`, not `eval`: what the layout emits has to be executable, and
    // the test says so by running it.
    new Function('window', publicConfigScript(config))(injected);

    expect(publicConfig()).toEqual(config);
  });

  it('escapes a value that would otherwise close the script element', () => {
    const script = publicConfigScript(
      readPublicConfig({ ROUTER_UI_AUTH_CALLBACK_URL: '/</script><script>alert(1)</script>' }),
    );

    expect(script).not.toContain('</script>');
    new Function('window', script)(injected);
    expect(publicConfig().authCallbackUrl).toBe('/</script><script>alert(1)</script>');
  });
});
