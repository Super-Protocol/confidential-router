import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { routerConfig } from '../config.js';
import { User } from '../db/entities/user.entity.js';

/** Which sign-in paths this deployment actually offers, right now. */
export interface SignInOptions {
  /** A bootstrap token can create the first account — see `bootstrapAdmin`. */
  bootstrap: boolean;
  github: boolean;
  google: boolean;
  magicLink: boolean;
}

/**
 * What the sign-in screen may offer.
 *
 * Everything here is derivable from the router config, so it is public: a
 * console that renders a "Continue with GitHub" button on a deployment with no
 * GitHub app sends the viewer down a path that can only end in an error, and
 * the marketplace install this exists for has neither OAuth nor mail.
 *
 * `bootstrap` is the one flag that is not config alone — it also depends on the
 * deployment still being empty. The authority on that is the endpoint itself
 * (`bootstrap-admin.plugin.ts` re-checks against Better Auth's own adapter
 * before it creates anything); this is the hint the login screen renders from,
 * and a stale `true` costs a 404, not an account.
 */
@Injectable()
export class SignInOptionsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
  ) {}

  async get(): Promise<SignInOptions> {
    const { auth } = this.config;
    return {
      bootstrap: await this.bootstrapAvailable(),
      github: auth.github !== undefined,
      google: auth.google !== undefined,
      magicLink: auth.magicLink.mailer !== 'none',
    };
  }

  /**
   * `exists`, not `count`: the question is whether the deployment has an owner
   * yet, and an unconfigured deployment must not pay for a full table scan on
   * every anonymous page load either.
   */
  private async bootstrapAvailable(): Promise<boolean> {
    if (this.config.auth.bootstrapToken === undefined) {
      return false;
    }
    return !(await this.dataSource.getRepository(User).exists());
  }
}
