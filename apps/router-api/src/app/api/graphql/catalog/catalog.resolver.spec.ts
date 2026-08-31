import { describe, expect, it, vi } from 'vitest';
import type { SessionUser, WorkspaceScopeService } from '../../../auth/index.js';
import { CatalogResolver } from './catalog.resolver.js';
import type { CatalogViewService } from './catalog-view.service.js';

const USER: SessionUser = { id: 'user-1', email: 'dev@example.test', name: null, image: null };

function build(overrides: { defaultForUser?: unknown; requireMembership?: unknown; modelViews?: unknown } = {}) {
  const modelViews = overrides.modelViews ?? vi.fn().mockResolvedValue([{ id: 'meta/llama:tdx' }]);
  const view = { modelViews, endpointViews: vi.fn().mockResolvedValue([]) } as unknown as CatalogViewService;
  const workspaces = {
    defaultForUser: overrides.defaultForUser ?? vi.fn().mockResolvedValue({ id: 'ws-1' }),
    requireMembership: overrides.requireMembership ?? vi.fn().mockResolvedValue({ id: 'ws-1' }),
  } as unknown as WorkspaceScopeService;
  return { resolver: new CatalogResolver(view, workspaces), view, workspaces, modelViews };
}

describe('CatalogResolver.models', () => {
  it('resolves the anonymous caller against no workspace at all', async () => {
    // The public listing exists so the catalogue can be read before anyone signs
    // up; there is no usage to attribute, and no membership lookup to make.
    const { resolver, workspaces, modelViews } = build();

    await resolver.models(undefined);

    expect(modelViews).toHaveBeenCalledWith(null, undefined);
    expect(workspaces.defaultForUser).not.toHaveBeenCalled();
  });

  it('resolves a signed-in caller against the workspace the console opens on', async () => {
    const { resolver, modelViews } = build();

    await resolver.models(USER, 'Intel TDX');

    expect(modelViews).toHaveBeenCalledWith('ws-1', 'Intel TDX');
  });

  it('falls back to no workspace for a user who owns none', async () => {
    const { resolver, modelViews } = build({ defaultForUser: vi.fn().mockResolvedValue(null) });

    await resolver.models(USER);

    expect(modelViews).toHaveBeenCalledWith(null, undefined);
  });

  it('answers null for an unknown model id instead of an error', async () => {
    const { resolver } = build();

    expect(await resolver.model(undefined, 'nope/nothing')).toBeNull();
  });
});

describe('CatalogResolver.endpoints', () => {
  it('checks membership before it reads anything', async () => {
    const requireMembership = vi.fn().mockResolvedValue({ id: 'ws-9' });
    const { resolver, view } = build({ requireMembership });

    await resolver.endpoints(USER, 'ws-9');

    expect(requireMembership).toHaveBeenCalledWith('user-1', 'ws-9');
    expect(view.endpointViews).toHaveBeenCalledWith('ws-9');
  });

  it('reads the workspace the membership check resolved, not the id the client sent', async () => {
    // `requireMembership` is the only thing that turns a client-supplied id into
    // a workspace; passing its result on is what keeps a forged id inert.
    const requireMembership = vi.fn().mockResolvedValue({ id: 'ws-resolved' });
    const { resolver, view } = build({ requireMembership });

    await resolver.endpoints(USER, 'ws-sent');

    expect(view.endpointViews).toHaveBeenCalledWith('ws-resolved');
  });
});
