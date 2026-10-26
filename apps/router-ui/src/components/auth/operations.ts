import { graphql } from '../../generated';

/**
 * The one query the console makes before there is a session: which sign-in
 * paths this deployment actually offers.
 *
 * Without it the screen would render a "Continue with GitHub" button on a
 * deployment with no GitHub app, and would hide the bootstrap path on the fresh
 * marketplace install that is the only place it works.
 */
export const SIGN_IN_OPTIONS_QUERY = graphql(`
  query SignInOptions {
    signInOptions {
      bootstrap
      adminRecovery
      github
      google
      emailCode
      emailCodeLength
      magicLink
      inviteRequired
    }
  }
`);

/**
 * Whether the deployment's mail provider is dropping messages to the address a
 * code was just asked for (SUP-551).
 *
 * Asked once the code screen appears, because the answer changes what that
 * screen may honestly say. It is a fact about the mailbox and not about any
 * account, so asking it before there is a session gives nothing away — see the
 * resolver.
 */
export const SIGN_IN_MAIL_STATE_QUERY = graphql(`
  query SignInMailState($email: String!) {
    signInMailState(email: $email) {
      state
    }
  }
`);
