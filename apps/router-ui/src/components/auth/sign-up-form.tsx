'use client';

import { useQuery } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader } from '@confidential-router/ui/components/card';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import Link from 'next/link';
import * as React from 'react';
import { AuthRequestError, completeSignIn, signUpWithPassword } from '../../lib/auth';
import { captureConsoleEvent } from '../../lib/console-analytics';
import { inviteContextOf, normaliseInviteCode, rememberInvite } from '../../lib/invite';
import { type InviteRefusalCode, inviteRefusalOf, isInviteRefusalCode } from '../../lib/invite-refusal';
import { InviteNotice, useInviteLookup } from './invite-notice';
import { messageOf } from './messages';
import { SIGN_IN_OPTIONS_QUERY } from './operations';

/**
 * Sign-up failures the router can produce, in the viewer's terms. The 422 is
 * Better Auth's "this address is taken", which on a screen whose only job is to
 * create an account deserves a way forward rather than a restatement.
 */
const SIGN_UP_MESSAGES = {
  404: 'This deployment does not offer password sign-up.',
  422: 'An account already exists for that address. Sign in instead.',
};

/**
 * Where a viewer who signed up with an invitation lands.
 *
 * The Credits screen rather than the overview, because the one thing that
 * happened while they were filling in the form is that $100 arrived — or did not,
 * and that is the screen that says which (SUP-145). `welcome=invite` is what
 * `CreditsScreen` renders the grant card on, and it clears itself from the URL.
 */
export const INVITE_WELCOME_PATH = '/credits?welcome=invite';

/**
 * Creating an account on a deployment that cannot send mail.
 *
 * No verification round trip and no reset link: the address is never proven,
 * because proving it needs a mailer and the whole point of this path is not
 * having one. It exists so that a deployment whose bootstrap token created one
 * administrator can be used by a second person (SUP-112), and it is the path the
 * launch campaign's invitations lead to (SUP-140).
 */
export function SignUpForm() {
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /**
   * A refusal from the router, either carried back by a magic-link or OAuth
   * redirect (`?error=`) or answered to this form's own POST. Read once from the
   * URL, for the same reason the invitation context is.
   */
  const [refusal, setRefusal] = React.useState<InviteRefusalCode | null>(() =>
    inviteRefusalOf(globalThis.location?.search ?? ''),
  );

  // Read once, from the URL this page was opened with. A `useSearchParams` here
  // would need a Suspense boundary for a value that cannot change without a
  // navigation, and the fallback to storage is not in the router's parameters
  // anyway.
  const [context] = React.useState(() => inviteContextOf(globalThis.location?.search ?? ''));
  const [code, setCode] = React.useState<string | null>(context.code);
  const invite = useInviteLookup(code);

  const {
    data,
    loading,
    error: optionsError,
    refetch,
  } = useQuery(SIGN_IN_OPTIONS_QUERY, {
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
  });
  const settled = !loading || data !== undefined;
  // Unlike the sign-in screen, a failed query is not a reason to offer this:
  // there is nothing to fall back to, and a form that can only 404 is worse
  // than a sentence saying where to go instead.
  const offered = data?.signInOptions.password ?? false;
  /**
   * No answer at all, as opposed to an answer of "no". Said as what it is: on a
   * deployment whose API is not up yet, "does not offer password sign-up" sent
   * people looking for a setting that was on all along (SUP-248).
   */
  const unreachable = data === undefined && optionsError !== undefined;
  const minLength = data?.signInOptions.passwordMinLength ?? 0;
  /**
   * Invite-only registration (SUP-173). Defaults to false while the answer is on
   * its way, which never renders: the form is behind `settled` below, and the
   * router refuses the sign-up anyway — the flag decides what this screen says,
   * never whether an account can be created.
   */
  const inviteRequired = data?.signInOptions.inviteRequired ?? false;
  /**
   * Nothing else can produce an account here, so an unconfirmed code is normally
   * a submission the router is certain to refuse — held back rather than sent.
   *
   * `unavailable` is the exception, and SUP-176 is why. That answer is settled
   * and final, and it is deliberately imprecise: the public lookup collapses
   * claimed, expired, withdrawn and never-issued into one reason so that it
   * cannot be used to tell a real code from a guess. The router keeps the
   * distinction and answers it as a typed 403 from `user.create.before` — ahead
   * of the insert, so a refused submit creates no account, no session and no
   * grant. Holding the button here is what made a spent link and a typo read
   * identically in a browser; submitting is the only way the visitor reads the
   * one refusal they can act on alone. It leaks nothing new either: that POST
   * already answers the three codes to any caller, and it costs an email and a
   * password per guess, where the lookup this protects is a free GET.
   *
   * `checking` and `unknown` stay held, because neither is an answer: one is
   * about to arrive and the other can be asked for again, and "wait" is honest
   * advice in both. `none` stays held too — there is no code to submit, and the
   * notice above already says what the router would.
   */
  const blockedOnInvite = inviteRequired && invite.kind !== 'ready' && invite.kind !== 'unavailable';

  // One per page load, anonymous, and a volume rather than a funnel step —
  // linking it to the account that appears later would need an identifier stored
  // in this browser (`docs/contracts/analytics-events.md`, `signup_started`).
  //
  // Held until the lookup settles, because `campaign` is the property the two
  // halves of the funnel are joined on and only the lookup knows it. The wait is
  // bounded by the lookup's own outcome, which includes failing.
  const reported = React.useRef(false);
  React.useEffect(() => {
    if (reported.current || invite.kind === 'checking') return;
    reported.current = true;

    void captureConsoleEvent('signup_started', {
      has_invite: context.code !== null,
      campaign: invite.kind === 'ready' ? invite.campaign : undefined,
      utm_campaign: context.utmCampaign ?? undefined,
      entry: context.entry,
    });
  }, [context, invite]);

  // Kept across the console's own navigations — a reload, a detour to `/login`
  // — so the code survives without ever being in this form's markup.
  React.useEffect(() => {
    if (code) rememberInvite(code);
  }, [code]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setRefusal(null);
    setPending(true);
    try {
      // Sent whatever the lookup said: its answer is a snapshot, and the only
      // thing that decides is the redemption inside account creation.
      await signUpWithPassword({ email, password, name, inviteCode: code });
      completeSignIn(code ? INVITE_WELCOME_PATH : undefined);
    } catch (caught) {
      // An invite-only refusal is about the code, not about the form, so it is
      // rendered where the code is rather than under the password field. The two
      // that can race past the live lookup — the last seat taken between the
      // check and the submit, a code withdrawn in between — only ever arrive here.
      const code = caught instanceof AuthRequestError ? caught.code : undefined;
      if (isInviteRefusalCode(code)) {
        setRefusal(code);
        setError(null);
      } else {
        setError(messageOf(caught, SIGN_UP_MESSAGES));
      }
      setPending(false);
    }
  };

  if (!settled) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-2 pt-6" data-testid="sign-up-options-loading">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (unreachable) {
    return (
      <Card>
        <CardHeader>
          <h1 className="font-semibold leading-none">Sign up</h1>
          <CardDescription data-testid="sign-up-api-unreachable">
            The console cannot reach this deployment's API, so it cannot tell which ways of signing up it offers. If the
            deployment was created moments ago it may still be starting; try again shortly.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Button variant="brand" className="w-full" disabled={loading} onClick={() => void refetch().catch(() => {})}>
            {loading ? 'Trying…' : 'Try again'}
          </Button>
          <Button variant="outline" className="w-full" asChild>
            <Link href="/login">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!offered) {
    return (
      <Card>
        <CardHeader>
          <h1 className="font-semibold leading-none">Sign up</h1>
          <CardDescription>
            This deployment does not offer password sign-up. Ask whoever runs it for an invitation, or use one of the
            sign-in methods it does offer.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="w-full" asChild>
            <Link href="/login">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <h1 className="font-semibold leading-none">Create an account</h1>
        <CardDescription>
          {inviteRequired
            ? 'Registration is by invitation: an account is created only for a code that has not been used yet. Your prompts are metered, never stored.'
            : 'Your prompts are metered, never stored. There is no confirmation mail on this deployment — the account works from the moment you create it.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Normalised here, so a code the URL carried and a code someone typed
            are the same string by the time anything looks at either. */}
        <InviteNotice
          state={invite}
          required={inviteRequired}
          refusal={refusal}
          onCodeEntered={(entered) => {
            // A new code is a new attempt: the refusal on screen was about the
            // old one, and leaving it up would read as a verdict on this one.
            setRefusal(null);
            setCode(normaliseInviteCode(entered));
          }}
        />

        <form className="flex flex-col gap-2" onSubmit={(event) => void handleSubmit(event)}>
          <Label htmlFor="name">Name (optional)</Label>
          <Input
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            placeholder="Ada Lovelace"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-describedby={error ? 'sign-up-error' : undefined}
            aria-invalid={error !== null || undefined}
          />
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby={error ? 'sign-up-error' : 'password-hint'}
            aria-invalid={error !== null || undefined}
          />
          {/* The rule is the router's (`auth.password.minLength`), reported
              rather than hard-coded: a deployment that raised it would
              otherwise be advertising a floor it refuses. */}
          <p id="password-hint" className="text-muted-foreground text-xs">
            {data?.signInOptions.passwordReset
              ? `At least ${minLength} characters.`
              : `At least ${minLength} characters. There is no password reset on this deployment, so use something you will not lose.`}
          </p>
          <Button
            type="submit"
            variant="brand"
            className="w-full"
            disabled={pending || blockedOnInvite || email.length === 0 || password.length < minLength}
          >
            {pending ? 'Creating…' : 'Create account'}
          </Button>
          {/* Why the button is dead, said next to it: a disabled control with no
              explanation is the failure this issue was opened about. */}
          {blockedOnInvite ? (
            <p className="text-muted-foreground text-xs" data-testid="sign-up-blocked-on-invite">
              {invite.kind === 'checking'
                ? 'Checking your invitation…'
                : 'Enter a working invitation code above to create an account.'}
            </p>
          ) : null}
        </form>

        {error ? (
          <p id="sign-up-error" role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        <p className="text-center text-muted-foreground text-sm">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-foreground underline underline-offset-4">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
