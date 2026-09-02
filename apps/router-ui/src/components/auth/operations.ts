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
      github
      google
      magicLink
      password
      passwordMinLength
    }
  }
`);
