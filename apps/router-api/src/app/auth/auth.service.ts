import type { IncomingHttpHeaders } from 'node:http';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { type Auth, type BetterAuthOptions, betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import { routerConfig } from '../config.js';
import { buildAuthOptions, createAuthDatabase } from './auth.options.js';
import { runAuthMigrations } from './auth-schema.js';
import { MAGIC_LINK_MAILER, type MagicLinkMailer } from './magic-link-mailer.js';
import { WorkspaceProvisioningService } from './workspace-provisioning.service.js';

/** The subject of an authenticated console request. */
export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
}

/**
 * Owns the Better Auth instance and is the only thing in the app that talks to
 * it. ADR-004 §3 keeps this boundary deliberately narrow — `getSessionUser` and
 * `handler` are the whole surface — so the library can be replaced without
 * touching guards, resolvers or controllers.
 */
@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name);
  private readonly instance: Auth;
  private readonly options: BetterAuthOptions;
  private readonly database: ReturnType<typeof createAuthDatabase>;
  private readonly migrationsRun: boolean;

  constructor(
    @Inject(routerConfig.KEY) config: ConfigType<typeof routerConfig>,
    @Inject(MAGIC_LINK_MAILER) mailer: MagicLinkMailer,
    workspaces: WorkspaceProvisioningService,
  ) {
    this.database = createAuthDatabase(config);
    this.migrationsRun = config.database.migrationsRun;
    this.options = buildAuthOptions({
      config,
      mailer,
      database: this.database,
      onUserCreated: async (user) => {
        await workspaces.ensurePersonalWorkspace(user);
      },
    });
    this.instance = betterAuth(this.options);
  }

  /**
   * Applies Better Auth's own migrations when the deployment asked for
   * migrate-on-boot — the SQLite default, so `nx serve` works on an empty
   * directory. PostgreSQL leaves this off and runs `router-api-migrate` once
   * instead of racing every replica.
   */
  async onModuleInit(): Promise<void> {
    if (!this.migrationsRun) {
      return;
    }
    await runAuthMigrations(this.options);
    this.logger.log('Better Auth schema is up to date.');
  }

  /** The Fetch-API handler mounted at `/auth/*` by `main.ts`. */
  get handler(): Auth['handler'] {
    return this.instance.handler;
  }

  get api(): Auth['api'] {
    return this.instance.api;
  }

  /**
   * Resolves the caller from the session cookie, or `null` when there is no
   * valid session. Never throws on a bad or expired cookie — an anonymous
   * request is a normal outcome, not an error.
   */
  async getSessionUser(headers: IncomingHttpHeaders): Promise<SessionUser | null> {
    try {
      const session = await this.instance.api.getSession({ headers: fromNodeHeaders(headers) });
      if (!session?.user) {
        return null;
      }
      const { id, email, name, image } = session.user;
      return { id, email, name: name ?? null, image: image ?? null };
    } catch (error) {
      this.logger.debug(`Session lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    const handle = this.database as { end?: () => Promise<void>; close?: () => void };
    if (typeof handle?.end === 'function') {
      await handle.end();
    } else if (typeof handle?.close === 'function') {
      handle.close();
    }
  }
}
