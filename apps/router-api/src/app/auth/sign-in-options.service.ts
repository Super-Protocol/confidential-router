import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { routerConfig } from '../config.js';
import { User } from '../db/entities/user.entity.js';
import { emailCodeEnabled, magicLinkEnabled } from '../mail/mail-settings.js';
import { EMAIL_CODE_LENGTH } from './auth.options.js';

/** Which sign-in paths this deployment actually offers, right now. */
export interface SignInOptions {
  /** A bootstrap token can create the first account — see `bootstrapAdmin`. */
  bootstrap: boolean;
  /**
   * The bootstrap token can sign its own account back in (SUP-269): a token is
   * configured and the account it created exists. The way in for the
   * administrator when no code can be mailed — no mailer, or one that is down.
   */
  adminRecovery: boolean;
  github: boolean;
  google: boolean;
  /**
   * A one-time code can be mailed (SUP-269): the deployment has a mailer. This
   * is how an account signs in and how one is created; without it a deployment
   * has OAuth, if configured, and the bootstrap token.
   */
  emailCode: boolean;
  /** How many digits a code has, so the form can size its field and know when one is complete. */
  emailCodeLength: number;
  /** A one-time *link* can be mailed as well. Off on a marketplace deployment. */
  magicLink: boolean;
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
 * `bootstrap` and `adminRecovery` are the two flags that are not config alone —
 * they also depend on whether the deployment is still empty and whether the
 * token's own account exists. The authority on both is the endpoint itself
 * (`bootstrap-admin.plugin.ts` re-checks against Better Auth's own adapter
 * before it does anything); this is the hint the login screen renders from, and
 * a stale `true` costs a 404, not an account.
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
      ...(await this.bootstrapState()),
      github: auth.github !== undefined,
      google: auth.google !== undefined,
      emailCode: emailCodeEnabled(this.config),
      emailCodeLength: EMAIL_CODE_LENGTH,
      magicLink: magicLinkEnabled(this.config),
      inviteRequired: auth.requireInviteForSignUp,
    };
  }

  /**
   * `exists`, not `count`: the question is whether the deployment has an owner
   * yet, and an unconfigured deployment must not pay for a full table scan on
   * every anonymous page load either.
   *
   * The two are mutually exclusive by construction: the token creates its
   * account on an empty deployment and signs back into it on any other.
   */
  private async bootstrapState(): Promise<Pick<SignInOptions, 'bootstrap' | 'adminRecovery'>> {
    const { bootstrapToken, bootstrapEmail } = this.config.auth;
    if (bootstrapToken === undefined) {
      return { bootstrap: false, adminRecovery: false };
    }
    const users = this.dataSource.getRepository(User);
    if (!(await users.exists())) {
      return { bootstrap: true, adminRecovery: false };
    }
    return {
      bootstrap: false,
      adminRecovery: await users.exists({ where: { email: bootstrapEmail.toLowerCase() } }),
    };
  }
}
