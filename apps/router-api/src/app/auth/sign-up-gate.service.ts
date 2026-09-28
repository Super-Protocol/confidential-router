import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { APIError } from 'better-auth/api';
import { routerConfig } from '../config.js';
import {
  SIGN_UP_REFUSAL_MESSAGES,
  type SignUpRefusalCode,
  signUpRefusalCodeOf,
} from '../invites/invite-requirement.js';
import { InvitesService } from '../invites/invites.service.js';
import type { SignUpInvite } from '../invites/sign-up-invite.js';

/**
 * Whether this deployment lets an account come into existence at all
 * (`auth.requireInviteForSignUp`, SUP-173).
 *
 * It runs in Better Auth's `databaseHooks.user.create.before`, which is the one
 * place every sign-up path passes through: password posts its own body, a magic
 * link arrives as a verification GET, and an OAuth callback is a URL the provider
 * built — three different requests, one insert. Gating the insert rather than the
 * three routes is what makes "no path creates an account without a code" a
 * property of the system instead of a list somebody has to keep complete. It is
 * also the only seam that can tell a sign-up from a sign-in on the two paths
 * where one request does both.
 *
 * Before, not after, and that is the point. The grant stays where SUP-142 put it
 * (`user.create.after`), because it credits a workspace that does not exist yet
 * here; a *requirement* enforced after the insert could only be met by deleting
 * an account that had already been created, which is the half-created account
 * this exists to prevent.
 *
 * **The check is a read, and it cannot be anything else.** Claiming the seat here
 * — which would make two sign-ups racing for the last seat of one code resolve to
 * one account rather than two — needs a write, and a write from this hook
 * deadlocks: Better Auth holds an open read transaction across it, and a second
 * connection's `UPDATE` is refused with `SQLITE_BUSY` immediately, in WAL as well
 * as in the default journal mode (a read snapshot cannot be upgraded past another
 * connection's commit). So the seat is still claimed by `claimSeat` inside the
 * grant, one atomic `UPDATE` as before, and the window between this read and that
 * claim is the one case the gate does not cover: two sign-ups submitted within
 * milliseconds of each other on the *same* code both get an account, and only one
 * gets the credit. `SignUpProvisioning` logs the loser, and on an invite-only
 * deployment that log line is the only way it can happen at all.
 */
@Injectable()
export class SignUpGate {
  private readonly logger = new Logger(SignUpGate.name);

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    private readonly invites: InvitesService,
  ) {}

  /** Whether this deployment is invite-only, for the public `signInOptions`. */
  get required(): boolean {
    return this.config.auth.requireInviteForSignUp;
  }

  /**
   * Lets the sign-up through, or throws the refusal the console renders.
   *
   * Does nothing at all on a deployment that is not invite-only, which is the
   * default and leaves SUP-142's behaviour untouched: there a code that cannot be
   * redeemed costs the credit and never the account.
   */
  async admit(invite: SignUpInvite, bootstrap: boolean): Promise<void> {
    if (!this.required || bootstrap) {
      return;
    }
    if (!invite.code) {
      throw this.refuse('missing');
    }

    const found = await this.invites.lookup(invite.code);
    if (!found.valid) {
      throw this.refuse(found.reason);
    }
  }

  private refuse(reason: Parameters<typeof signUpRefusalCodeOf>[0]): APIError {
    const code = signUpRefusalCodeOf(reason);
    // The real reason, which the refusal deliberately does not carry: on a launch
    // running grants-only this line is the difference between a mailing that went
    // to the wrong list and a campaign whose codes were all spent.
    this.logger.log(`Sign-up refused: ${code} (${reason}).`);
    return refusal(code);
  }
}

/**
 * The refusal, in the one shape all three sign-up paths can carry.
 *
 * Better Auth answers a password sign-up with the body verbatim, and both the
 * magic-link verification and the OAuth callback recognise an `APIError` with a
 * `code` and redirect to their error callback with `?error=<code>` — so the
 * console gets the same three values whichever way the visitor arrived.
 *
 * 403 rather than 401: the caller is not being asked to authenticate, and a 401
 * from `/auth/*` is what an expired session looks like to everything in front of
 * us.
 */
function refusal(code: SignUpRefusalCode): APIError {
  return new APIError('FORBIDDEN', { code, message: SIGN_UP_REFUSAL_MESSAGES[code] });
}
