'use client';

import { useQuery } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader } from '@confidential-router/ui/components/card';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { MailCheck, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import {
  AuthRequestError,
  completeSignIn,
  requestSignInCode,
  type SocialProvider,
  signInWithCode,
  signInWithMagicLink,
  signInWithProvider,
} from '../../lib/auth';
import { readInviteCode, rememberInvite } from '../../lib/invite';
import {
  INVITE_REFUSAL_COPY,
  type InviteRefusalCode,
  inviteRefusalOf,
  isInviteRefusalCode,
} from '../../lib/invite-refusal';
import { BootstrapForm, type BootstrapMode } from './bootstrap-form';
import { codeFailureOf, codeRequestMessageOf, EmailCodeStep } from './email-code-step';
import { messageOf } from './messages';
import { SIGN_IN_OPTIONS_QUERY } from './operations';
import { GitHubIcon, GoogleIcon } from './provider-icons';

type Pending = SocialProvider | 'magic-link' | 'code-request' | 'code-verify' | 'code-resend' | null;

/**
 * What to offer when the API cannot be reached.
 *
 * Everything, deliberately: the query failing says nothing about how this
 * deployment is configured, and a sign-in screen that hides every path because
 * one request timed out leaves the viewer with no way to even try. The two
 * token paths stay off — they are the ones that are normally unavailable, and
 * offering either blindly would suggest a fresh deployment, or an administrator
 * token, where there may be neither.
 */
const OFFER_EVERYTHING = {
  bootstrap: false,
  adminRecovery: false,
  github: true,
  google: true,
  emailCode: true,
  // The router's own constant; a guess here only decides when the button under
  // the code field wakes up, and the router checks the code either way.
  emailCodeLength: 6,
  magicLink: true,
};

export function SignInForm() {
  const [email, setEmail] = React.useState('');
  const [pending, setPending] = React.useState<Pending>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [linkSent, setLinkSent] = React.useState(false);
  /**
   * The code step: a code has been asked for, and the card is waiting for it.
   * `attempt` counts the codes that are dead — refused as spent, or replaced by
   * a new one — and is the step's `key`, so its field empties with each.
   */
  const [codeSent, setCodeSent] = React.useState(false);
  const [codeResent, setCodeResent] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  // Which of the token's two jobs the token form was opened for, if it is open.
  const [tokenForm, setTokenForm] = React.useState<BootstrapMode | null>(null);
  // Which of the two email paths the card is showing. `null` until the answer
  // arrives, because the deployment decides which one is the default.
  const [emailPath, setEmailPath] = React.useState<'code' | 'magic-link' | null>(null);

  /**
   * The invitation code this browser is carrying, if any.
   *
   * This is a sign-*in* screen, so usually there is none and nothing happens. But
   * every path here creates the account on first use — a mailed code, a magic
   * link and OAuth alike — so an invited visitor who never opens `/signup` is
   * registered from this screen, and the code has to travel from here too or the
   * grant is silently lost. It is safe to send for an address that already has
   * an account: redemption lives in account creation and nowhere else, so an
   * existing account cannot be topped up (SUP-142).
   */
  const [inviteCode] = React.useState(() => readInviteCode(globalThis.location?.search ?? ''));

  /**
   * A sign-*up* this screen started and the router refused (SUP-173).
   *
   * Two of the paths that create an account from here — a provider and a magic
   * link — finish as a navigation, so an invite-only refusal comes back as
   * `?error=` on this page rather than as a rejected promise; the third, a
   * mailed code, is this screen's own request and is answered with a 403. All
   * three are rendered here because this is where the button that caused it is:
   * the way out of it is to press the same one again with an invitation that
   * works.
   */
  const [refusal, setRefusal] = React.useState<InviteRefusalCode | null>(() =>
    inviteRefusalOf(globalThis.location?.search ?? ''),
  );

  // Kept for the round trip back. The OAuth callback reads the `cr_invite`
  // cookie, but a refusal lands the visitor back on this page with a URL the
  // provider built and none of our parameters on it — so a retry has nothing to
  // send unless the code was stored before the browser left.
  React.useEffect(() => {
    if (inviteCode) rememberInvite(inviteCode);
  }, [inviteCode]);

  const { data, loading } = useQuery(SIGN_IN_OPTIONS_QUERY, { fetchPolicy: 'cache-and-network' });
  const options = data?.signInOptions ?? OFFER_EVERYTHING;
  // A code is the default on a deployment that offers both: it signs the viewer
  // in on the device they are looking at, where a link signs in whichever
  // browser happens to open the mail.
  const path = emailPath ?? (options.emailCode ? 'code' : 'magic-link');
  const showsCode = options.emailCode && path === 'code';
  const showsMagicLink = options.magicLink && path === 'magic-link';

  const handleProvider = async (provider: SocialProvider) => {
    setError(null);
    setPending(provider);
    try {
      await signInWithProvider(provider, inviteCode);
      // On success the browser navigates away, so `pending` is never cleared.
    } catch (caught) {
      setError(messageOf(caught));
      setPending(null);
    }
  };

  const handleMagicLink = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setPending('magic-link');
    try {
      await signInWithMagicLink(email, inviteCode);
      setLinkSent(true);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setPending(null);
    }
  };

  /** Asks for a code — the first one, or a replacement from the code step. */
  const requestCode = async (kind: 'code-request' | 'code-resend') => {
    setError(null);
    setPending(kind);
    try {
      await requestSignInCode(email);
      if (kind === 'code-resend') {
        // The code on screen may still be good, but the one in the newest mail
        // is the one the viewer is about to read — so the field starts over.
        setAttempt((current) => current + 1);
      }
      setCodeResent(kind === 'code-resend');
      setCodeSent(true);
    } catch (caught) {
      setError(codeRequestMessageOf(caught));
    } finally {
      setPending(null);
    }
  };

  const handleCode = async (code: string) => {
    setError(null);
    setPending('code-verify');
    try {
      // The invitation rides along whether or not it will be used: the router
      // creates the account here if the address has none, and that creation is
      // the only place a code is redeemed.
      await signInWithCode({ email, code, inviteCode });
      completeSignIn();
    } catch (caught) {
      const refused = caught instanceof AuthRequestError ? caught.code : undefined;
      if (isInviteRefusalCode(refused)) {
        // An invite-only deployment would not create the account. The mailed
        // code was spent by being checked, so there is nothing left to do on
        // the code step: back to the card, where the refusal says where to go.
        setRefusal(refused);
        setCodeSent(false);
      } else {
        const failure = codeFailureOf(caught);
        setError(failure.message);
        if (failure.spent) setAttempt((current) => current + 1);
      }
      setCodeResent(false);
      setPending(null);
    }
  };

  if (tokenForm) {
    return <BootstrapForm mode={tokenForm} onCancel={() => setTokenForm(null)} />;
  }

  if (codeSent) {
    return (
      <EmailCodeStep
        key={attempt}
        email={email}
        length={options.emailCodeLength}
        submitLabel="Sign in"
        submittingLabel="Signing in…"
        pending={pending === 'code-verify' ? 'verify' : pending === 'code-resend' ? 'resend' : null}
        error={error}
        resent={codeResent}
        onSubmit={(code) => void handleCode(code)}
        onResend={() => void requestCode('code-resend')}
        onChangeAddress={() => {
          setError(null);
          setCodeSent(false);
        }}
      />
    );
  }

  if (linkSent) {
    return (
      <Card>
        <CardHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-brand-muted text-brand-emphasis">
            <MailCheck className="size-4" aria-hidden="true" />
          </div>
          <h1 className="font-semibold leading-none">Check your inbox</h1>
          <CardDescription>
            We sent a sign-in link to <span className="font-medium text-foreground">{email}</span>. It is valid once,
            and only for a few minutes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="w-full" onClick={() => setLinkSent(false)}>
            Use a different address
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Nothing is rendered from `OFFER_EVERYTHING` while the answer is still on its
  // way: a button that appears and then vanishes is worse than a moment of
  // skeleton, because it can be clicked in between.
  const settled = !loading || data !== undefined;
  const providers = [
    { id: 'github' as const, label: 'Continue with GitHub', icon: GitHubIcon, enabled: options.github },
    { id: 'google' as const, label: 'Continue with Google', icon: GoogleIcon, enabled: options.google },
  ].filter((provider) => provider.enabled);
  const mailsSomething = options.emailCode || options.magicLink;
  const nothingOffered = providers.length === 0 && !mailsSomething && !options.bootstrap && !options.adminRecovery;

  return (
    <Card>
      <CardHeader>
        <h1 className="font-semibold leading-none">Sign in</h1>
        <CardDescription>
          {options.emailCode
            ? 'Sign in with a code mailed to your address, or a provider.'
            : options.magicLink
              ? 'Use a provider, or have a one-time link mailed to you.'
              : 'This deployment cannot send mail, so sign-in is by a provider or the administrator’s first-sign-in token.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {refusal ? (
          <div
            className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3"
            role="alert"
            data-testid={`invite-refused-${refusal}`}
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-medium text-sm">{INVITE_REFUSAL_COPY[refusal].title}</p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {INVITE_REFUSAL_COPY[refusal].detail}{' '}
                <Link href="/signup" className="font-medium text-foreground underline underline-offset-4">
                  Enter a code
                </Link>
                .
              </p>
            </div>
          </div>
        ) : null}

        {!settled ? (
          <div className="flex flex-col gap-2" data-testid="sign-in-options-loading">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : (
          <>
            {providers.length > 0 ? (
              <div className="flex flex-col gap-2">
                {providers.map(({ id, label, icon: Icon }) => (
                  <Button
                    key={id}
                    variant="outline"
                    className="w-full"
                    disabled={pending !== null}
                    onClick={() => void handleProvider(id)}
                  >
                    <Icon className="size-4" />
                    {pending === id ? 'Redirecting…' : label}
                  </Button>
                ))}
              </div>
            ) : null}

            {providers.length > 0 && mailsSomething ? (
              <div className="flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 bg-border" />
                <span className="text-muted-foreground text-xs uppercase tracking-wide">or</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            ) : null}

            {/* One form for both email paths: they ask for the same address,
                and only the verb differs. */}
            {showsCode || showsMagicLink ? (
              <form
                className="flex flex-col gap-2"
                onSubmit={(event) => {
                  if (showsCode) {
                    event.preventDefault();
                    void requestCode('code-request');
                  } else {
                    void handleMagicLink(event);
                  }
                }}
              >
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
                  aria-describedby={error ? 'sign-in-error' : undefined}
                  aria-invalid={error !== null || undefined}
                />
                <Button
                  type="submit"
                  variant="brand"
                  className="w-full"
                  disabled={pending !== null || email.length === 0}
                >
                  {showsCode
                    ? pending === 'code-request'
                      ? 'Sending…'
                      : 'Email me a code'
                    : pending === 'magic-link'
                      ? 'Sending…'
                      : 'Email me a link'}
                </Button>
              </form>
            ) : null}

            {error ? (
              <p id="sign-in-error" role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}

            {/* Only where both are configured. The address is kept across the
                switch, because it is the same address either way. */}
            {options.emailCode && options.magicLink ? (
              <Button
                variant="ghost"
                className="w-full"
                disabled={pending !== null}
                onClick={() => {
                  setError(null);
                  setEmailPath(path === 'code' ? 'magic-link' : 'code');
                }}
              >
                {path === 'code' ? 'Email me a link instead' : 'Use a code instead'}
              </Button>
            ) : null}

            {/* Only where a code can be mailed: that is what creates an account
                on the sign-up screen, which says so itself otherwise. */}
            {options.emailCode ? (
              <p className="text-center text-muted-foreground text-sm">
                No account yet?{' '}
                {/* `from=login` is what makes `signup_started` able to tell a
                    visitor who came through this screen from one who opened the
                    sign-up page directly (`entry` in the taxonomy). */}
                <Link href="/signup?from=login" className="font-medium text-foreground underline underline-offset-4">
                  Create one
                </Link>
              </p>
            ) : null}

            {/* A fresh deployment has no other way in, so this is the primary
                action there and a footnote nowhere else — the API only reports
                it while the token is configured and no account exists. */}
            {options.bootstrap ? (
              <Button
                variant={providers.length === 0 && !mailsSomething ? 'brand' : 'outline'}
                className="w-full"
                onClick={() => setTokenForm('setup')}
              >
                Have a bootstrap token?
              </Button>
            ) : null}

            {/* The same token, once the account it created exists (SUP-269): it
                signs that one account back in, which is what keeps a deployment
                that cannot mail a code from losing its administrator with the
                session cookie. Low-key wherever there is another way in — it is
                nobody else's — and the router never reports it together with
                `bootstrap`. */}
            {options.adminRecovery ? (
              <Button
                variant={providers.length === 0 && !mailsSomething ? 'outline' : 'ghost'}
                className="w-full text-muted-foreground"
                disabled={pending !== null}
                onClick={() => setTokenForm('recovery')}
              >
                Administrator: use the first-sign-in token
              </Button>
            ) : null}

            {nothingOffered ? (
              <p role="alert" className="text-muted-foreground text-sm">
                This deployment has no sign-in method configured. Set an OAuth app, a mailer, or a bootstrap token in
                the router configuration.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
