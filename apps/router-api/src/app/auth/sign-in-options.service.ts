import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { routerConfig } from '../config.js';
import { User } from '../db/entities/user.entity.js';
import { magicLinkEnabled, passwordResetEnabled } from '../mail/mail-settings.js';

/** Which sign-in paths this deployment actually offers, right now. */
export interface SignInOptions {
  /** A bootstrap token can create the first account — see `bootstrapAdmin`. */
  bootstrap: boolean;
  github: boolean;
  google: boolean;
  magicLink: boolean;
  /** Email and password, the one path that needs nothing outside the cluster. */
  password: boolean;
  /** `auth.password.minLength`, so the sign-up form states the real rule. */
  passwordMinLength: number;
  /**
   * A forgotten password can be reset by mail: passwords are on *and* a mailer
   * is configured (SUP-269). False hides the console's "Forgot password?" link,
   * because the routes behind it are a 404.
   */
  passwordReset: boolean;
  /**
   * Registration is by invitation (`auth.requireInviteForSignUp`, SUP-173).
   *
   * Not a sign-in path but a property of every one of them: while it is true no
   * path creates an account without a valid, unredeemed code, so the sign-up
   * screen has to say so and block a submission it knows will be refused.
   */
  inviteRequired: boolean;
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
      magicLink: magicLinkEnabled(this.config),
      password: auth.password.enabled,
      passwordMinLength: auth.password.minLength,
      passwordReset: passwordResetEnabled(this.config),
      inviteRequired: auth.requireInviteForSignUp,
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
