import type { MockLink } from '@apollo/client/testing';
import { MockedProvider } from '@apollo/client/testing/react';
import { type RenderOptions, type RenderResult, render } from '@testing-library/react';
import type * as React from 'react';
import { feedbackOfferMock } from './components/feedback/feedback-mocks';
import { SESSION_QUERY, SessionProvider } from './components/session/session-provider';
import { VIEWER_IS_ADMIN_QUERY } from './components/session/use-viewer-is-admin';

export const TEST_WORKSPACES = [
  { id: 'ws-1', name: 'Default Workspace', slug: 'default', role: 'OWNER', balanceMicros: '170650000' },
  { id: 'ws-2', name: 'Evaluation', slug: 'evaluation', role: 'MEMBER', balanceMicros: '0' },
];

export const TEST_VIEWER = {
  id: 'user-1',
  email: 'developer@example.com',
  name: 'Dev Eloper',
  avatarUrl: null,
  workspaces: TEST_WORKSPACES,
};

/** A `Session` response good enough for anything that renders the shell. */
export function sessionMock(overrides: Record<string, unknown> = {}): MockLink.MockedResponse {
  return {
    request: { query: SESSION_QUERY },
    result: {
      data: {
        me: TEST_VIEWER,
        ...overrides,
      },
    },
    // `cache-and-network` fires the query again on remount within one test.
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

/**
 * The answer to `ViewerIsAdmin`, the small separate operation the sidebar and the
 * admin screens ask (see `use-viewer-is-admin.ts`). Pass `isAdminMock(true)` to
 * put a suite in front of the Administration group and the admin controls.
 */
export function isAdminMock(isAdmin: boolean): MockLink.MockedResponse {
  return {
    request: { query: VIEWER_IS_ADMIN_QUERY },
    result: { data: { me: { id: TEST_VIEWER.id, isAdmin } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

export interface RenderWithSessionOptions extends Omit<RenderOptions, 'wrapper'> {
  mocks?: MockLink.MockedResponse[];
}

/**
 * Apollo alone, with no session around it — for components that issue their own
 * operations but never read the viewer. `SessionProvider` calls `useRouter`,
 * which throws outside an app-router tree, so wrapping in it would force every
 * such test to mock `next/navigation` for a provider it does not use.
 */
export function renderWithApollo(
  ui: React.ReactElement,
  { mocks = [], ...rest }: RenderWithSessionOptions = {},
): RenderResult {
  return render(ui, {
    wrapper: ({ children }) => <MockedProvider mocks={mocks}>{children}</MockedProvider>,
    ...rest,
  });
}

/**
 * Renders inside the shell's providers.
 *
 * `feedbackOfferMock()` and `isAdminMock(false)` are appended to whatever the
 * caller passed, rather than left to each suite: `AppShell` asks for the offer
 * on every screen and `SessionProvider` asks for admin membership on every page,
 * and a test that forgot to stub either would fill its output with Apollo's "no
 * more mocked responses" warnings for queries it is not about. A caller that
 * cares passes its own — the first matching mock wins, so `isAdminMock(true)` in
 * `mocks` takes precedence over the default here.
 */
export function renderWithSession(ui: React.ReactElement, options: RenderWithSessionOptions = {}): RenderResult {
  const { mocks = [sessionMock()], ...rest } = options;

  return render(ui, {
    wrapper: ({ children }) => (
      <MockedProvider mocks={[...mocks, feedbackOfferMock(), isAdminMock(false)]}>
        <SessionProvider>{children}</SessionProvider>
      </MockedProvider>
    ),
    ...rest,
  });
}
