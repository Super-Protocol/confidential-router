import type { IncomingHttpHeaders } from 'node:http';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { type Auth, type BetterAuthOptions, betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import { routerConfig } from '../config.js';
import { MailService } from '../mail/mail.service.js';
import { buildAuthOptions, createAuthDatabase } from './auth.options.js';
import { dropStoredCredentials, runAuthMigrations } from './auth-schema.js';
import { SignUpGate } from './sign-up-gate.service.js';
import { SignUpProvisioning } from './sign-up-provisioning.service.js';

/** The subject of an authenticated console request. */
export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
}

/** A row of Better Auth's `user` table, as the deployment export carries it (SUP-271). */
export interface AuthUserRecord {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
}

/** Better Auth's adapter answers a page at a time, and a hundred rows unless told otherwise. */
const USER_PAGE_SIZE = 500;

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

  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    @Inject(routerConfig.KEY) config: ConfigType<typeof routerConfig>,
    mail: MailService,
    provisioning: SignUpProvisioning,
    gate: SignUpGate,
  ) {
    this.database = createAuthDatabase(config);
    this.migrationsRun = config.database.migrationsRun;
    this.options = buildAuthOptions({
      config,
      mail,
      database: this.database,
      onUserCreated: (user, invite, method) => provisioning.onUserCreated(user, invite, method),
      onBeforeUserCreated: (invite, bootstrap) => gate.admit(invite, bootstrap),
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
    const dropped = await dropStoredCredentials(this.database);
    if (dropped > 0) {
      this.logger.log(`Removed ${dropped} stored password credential(s): sign-in is by emailed code now (SUP-269).`);
    }
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

  /**
   * Renames the signed-in user.
   *
   * It goes through Better Auth rather than through TypeORM because Better Auth
   * owns the `user` table (ADR-004 §2) — `db/entities/user.entity.ts` is a
   * read-only projection and writing through it would put two owners on one
   * row. Keeping the write here also keeps the auth boundary at this service,
   * which is the property ADR-004 §3 asks for.
   */
  async updateProfile(headers: IncomingHttpHeaders, changes: { name: string }): Promise<SessionUser> {
    await this.instance.api.updateUser({ body: changes, headers: fromNodeHeaders(headers) });
    const user = await this.getSessionUser(headers);
    if (!user) {
      // The guard resolved a session moments ago, so this means it expired
      // mid-request rather than that the update failed silently.
      throw new UnauthorizedException('Authentication is required.');
    }
    return user;
  }

  /**
   * Every account, oldest first — the deployment export's `users` section (SUP-271).
   *
   * Read through Better Auth's adapter rather than the TypeORM projection for
   * the reason `updateProfile` writes through it: the table is the library's,
   * and `emailVerified` is a column the projection does not even map. Only the
   * `user` table is read. `account`, `session` and `verification` — where every
   * credential lives — are not, which is what keeps the export free of secrets.
   */
  async listUsers(): Promise<AuthUserRecord[]> {
    const { adapter } = await this.instance.$context;
    const users: AuthUserRecord[] = [];
    for (let offset = 0; ; offset += USER_PAGE_SIZE) {
      const page = await adapter.findMany<AuthUserRecord>({
        model: 'user',
        sortBy: { field: 'createdAt', direction: 'asc' },
        limit: USER_PAGE_SIZE,
        offset,
      });
      for (const row of page) {
        users.push({
          id: row.id,
          email: row.email,
          name: row.name ?? '',
          emailVerified: Boolean(row.emailVerified),
          image: row.image ?? null,
          createdAt: new Date(row.createdAt),
        });
      }
      if (page.length < USER_PAGE_SIZE) {
        return users;
      }
    }
  }

  /**
   * Creates accounts carried over from another deployment, under the ids they
   * had there (SUP-271).
   *
   * The adapter and not `internalAdapter.createUser`, on purpose: that one runs
   * `databaseHooks`, and an imported account must not pass the sign-up gate,
   * be given a second personal workspace, be credited the sign-up grant again or
   * be reported to analytics as a new sign-up. Its workspace and ledger arrive
   * with it, in the same bundle.
   *
   * No `account` row is written, so an imported account has no credential of
   * any kind: its owner proves the address again to sign in. Idempotent — an
   * id that is already here is left alone, which is what makes a retried import
   * safe.
   */
  async createImportedUsers(users: readonly AuthUserRecord[]): Promise<number> {
    const { adapter } = await this.instance.$context;
    let created = 0;
    for (const user of users) {
      if (await adapter.findOne({ model: 'user', where: [{ field: 'id', value: user.id }] })) {
        continue;
      }
      await adapter.create({
        model: 'user',
        data: {
          id: user.id,
          email: user.email.toLowerCase(),
          name: user.name,
          emailVerified: user.emailVerified,
          image: user.image,
          createdAt: user.createdAt,
          updatedAt: new Date(),
        },
        forceAllowId: true,
      });
      created += 1;
    }
    return created;
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
