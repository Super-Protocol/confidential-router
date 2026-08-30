import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { expect } from 'vitest';
import { type Harness, signIn as startSession } from './app-harness.js';

/**
 * The console's own way in: sign in with a magic link, then talk GraphQL with the
 * cookie a browser would have kept. Every e2e assertion here goes through the
 * same guards and resolvers a real session does.
 */

export interface ConsoleSession {
  harness: Harness;
  cookies: string[];
  workspaceId: string;
  email: string;
}

export async function signIn(harness: Harness, email: string): Promise<ConsoleSession> {
  const cookies = await startSession(harness, email);
  const session = { harness, cookies, email, workspaceId: '' };
  const me = await graphql(session, '{ me { workspaces { id } } }');
  return { ...session, workspaceId: me.data.me.workspaces[0].id };
}

/** A caller with no session at all, for asserting what the guards refuse. */
export function anonymous(harness: Harness): ConsoleSession {
  return { harness, cookies: [], email: '', workspaceId: '' };
}

export async function graphql(
  session: ConsoleSession,
  query: string,
  variables?: Record<string, unknown>,
): Promise<any> {
  const response = await request(session.harness.app.getHttpServer())
    .post('/graphql')
    .set('Cookie', session.cookies)
    .send({ query, variables })
    .expect(200);
  return response.body;
}

/** Fails loudly on a GraphQL error, so a broken query cannot look like an empty result. */
export async function expectData(
  session: ConsoleSession,
  query: string,
  variables?: Record<string, unknown>,
): Promise<any> {
  const body = await graphql(session, query, variables);
  expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
  return body.data;
}

export function dataSourceOf(harness: Harness): DataSource {
  return harness.app.get<DataSource>(getDataSourceToken());
}
