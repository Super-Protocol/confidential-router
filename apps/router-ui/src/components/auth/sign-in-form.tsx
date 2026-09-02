'use client';

import { useQuery } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader } from '@confidential-router/ui/components/card';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import {
  completeSignIn,
  type SocialProvider,
  signInWithMagicLink,
  signInWithPassword,
  signInWithProvider,
} from '../../lib/auth';
import { BootstrapForm } from './bootstrap-form';
import { messageOf } from './messages';
import { SIGN_IN_OPTIONS_QUERY } from './operations';
import { GitHubIcon, GoogleIcon } from './provider-icons';

type Pending = SocialProvider | 'magic-link' | 'password' | null;

/**
 * What to offer when the API cannot be reached.
 *
 * Everything, deliberately: the query failing says nothing about how this
 * deployment is configured, and a sign-in screen that hides every path because
 * one request timed out leaves the viewer with no way to even try. `bootstrap`
 * stays off — it is the one path that is normally unavailable, and offering it
 * blindly would suggest a fresh deployment where there may be none.
 */
const OFFER_EVERYTHING = {
  bootstrap: false,
  github: true,
  google: true,
  magicLink: true,
  password: true,
  passwordMinLength: 0,
};

/**
 * A password sign-in the router refused. 401 is the only one of these the
 * viewer can act on; the rest describe the deployment, not what was typed.
 */
const SIGN_IN_MESSAGES = {
  401: 'That email and password do not match an account here.',
  404: 'Password sign-in is not enabled on this deployment.',
};

export function SignInForm() {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [pending, setPending] = React.useState<Pending>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [linkSent, setLinkSent] = React.useState(false);
  const [bootstrapping, setBootstrapping] = React.useState(false);
  // Which of the two email paths the card is showing. `null` until the answer
  // arrives, because the deployment decides which one is the default.
  const [emailPath, setEmailPath] = React.useState<'password' | 'magic-link' | null>(null);

  const { data, loading } = useQuery(SIGN_IN_OPTIONS_QUERY, { fetchPolicy: 'cache-and-network' });
  const options = data?.signInOptions ?? OFFER_EVERYTHING;
  // A password is the sturdier of the two on a deployment that offers both: it
  // signs the viewer in here rather than sending them to an inbox.
  const path = emailPath ?? (options.password ? 'password' : 'magic-link');
  const showsPassword = options.password && path === 'password';
  const showsMagicLink = options.magicLink && path === 'magic-link';

  const handleProvider = async (provider: SocialProvider) => {
    setError(null);
    setPending(provider);
    try {
      await signInWithProvider(provider);
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
      await signInWithMagicLink(email);
      setLinkSent(true);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setPending(null);
    }
  };

  const handlePassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setPending('password');
    try {
      await signInWithPassword(email, password);
      completeSignIn();
    } catch (caught) {
      setError(messageOf(caught, SIGN_IN_MESSAGES));
      setPending(null);
    }
  };

  if (bootstrapping) {
    return <BootstrapForm onCancel={() => setBootstrapping(false)} />;
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
  const nothingOffered = providers.length === 0 && !options.magicLink && !options.password && !options.bootstrap;

  return (
    <Card>
      <CardHeader>
        <h1 className="font-semibold leading-none">Sign in</h1>
        <CardDescription>
          {options.password
            ? 'Use your email and password, or a provider.'
            : options.magicLink
              ? 'No passwords. Use a provider, or have a one-time link mailed to you.'
              : 'No passwords, and no mailer on this deployment.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
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

            {providers.length > 0 && (options.magicLink || options.password) ? (
              <div className="flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 bg-border" />
                <span className="text-muted-foreground text-xs uppercase tracking-wide">or</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            ) : null}

            {/* One form for both email paths: they ask for the same address,
                and only the password field and the verb differ. */}
            {showsPassword || showsMagicLink ? (
              <form
                className="flex flex-col gap-2"
                onSubmit={(event) => void (showsPassword ? handlePassword(event) : handleMagicLink(event))}
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
                {showsPassword ? (
                  <>
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      aria-describedby={error ? 'sign-in-error' : undefined}
                      aria-invalid={error !== null || undefined}
                    />
                  </>
                ) : null}
                <Button
                  type="submit"
                  variant="brand"
                  className="w-full"
                  disabled={pending !== null || email.length === 0 || (showsPassword && password.length === 0)}
                >
                  {showsPassword
                    ? pending === 'password'
                      ? 'Signing in…'
                      : 'Sign in'
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
            {options.password && options.magicLink ? (
              <Button
                variant="ghost"
                className="w-full"
                disabled={pending !== null}
                onClick={() => {
                  setError(null);
                  setEmailPath(path === 'password' ? 'magic-link' : 'password');
                }}
              >
                {path === 'password' ? 'Email me a link instead' : 'Use a password instead'}
              </Button>
            ) : null}

            {options.password ? (
              <p className="text-center text-muted-foreground text-sm">
                No account yet?{' '}
                <Link href="/signup" className="font-medium text-foreground underline underline-offset-4">
                  Create one
                </Link>
              </p>
            ) : null}

            {/* A fresh deployment has no other way in, so this is the primary
                action there and a footnote nowhere else — the API only reports
                it while the token is configured and no account exists. */}
            {options.bootstrap ? (
              <Button
                variant={providers.length === 0 && !options.magicLink && !options.password ? 'brand' : 'outline'}
                className="w-full"
                onClick={() => setBootstrapping(true)}
              >
                Have a bootstrap token?
              </Button>
            ) : null}

            {nothingOffered ? (
              <p role="alert" className="text-muted-foreground text-sm">
                This deployment has no sign-in method configured. Set an OAuth app, a mailer, a password provider, or a
                bootstrap token in the router configuration.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
