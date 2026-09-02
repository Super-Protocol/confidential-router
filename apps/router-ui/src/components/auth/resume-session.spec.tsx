import { CombinedGraphQLErrors } from '@apollo/client';
import type { MockLink } from '@apollo/client/testing';
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSignedIn, SIGNED_IN_COOKIE_NAME } from '../../lib/signed-in-cookie';
import { renderWithApollo } from '../../test-utils';
import { ResumeSession, SIGNED_IN_QUERY } from './resume-session';

const assign = vi.fn();

beforeEach(() => {
  vi.stubGlobal('location', { ...window.location, search: '', assign });
  assign.mockReset();
});

afterEach(() => {
  clearSignedIn();
  vi.unstubAllGlobals();
});

function probe(result: MockLink.MockedResponse['result']): MockLink.MockedResponse {
  return { request: { query: SIGNED_IN_QUERY }, result };
}

const LIVE = probe({ data: { me: { __typename: 'Viewer', id: 'user-1' } } });
const NONE = probe({
  errors: [new CombinedGraphQLErrors({ errors: [{ message: 'Authentication is required' }] }).errors[0]],
});

describe('ResumeSession', () => {
  it('restores the marker and leaves, for a session that arrived by redirect', async () => {
    // An OAuth callback and a magic link both come back from router-api without
    // running any of this app's code, so nothing raised the marker and the proxy
    // sent the browser to `/login` (SUP-113). This is what breaks the loop.
    renderWithApollo(<ResumeSession />, { mocks: [LIVE] });

    await waitFor(() => expect(document.cookie).toContain(`${SIGNED_IN_COOKIE_NAME}=1`));
    expect(assign).toHaveBeenCalledWith('/');
  });

  it('takes the viewer back to where the proxy stopped them', async () => {
    vi.stubGlobal('location', { ...window.location, search: '?next=%2Flogs', assign });

    renderWithApollo(<ResumeSession />, { mocks: [LIVE] });

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/logs'));
  });

  it('leaves a visitor with no session on the sign-in screen', async () => {
    renderWithApollo(<ResumeSession />, { mocks: [NONE] });

    await waitFor(() => expect(document.cookie).not.toContain(SIGNED_IN_COOKIE_NAME));
    expect(assign).not.toHaveBeenCalled();
  });
});
