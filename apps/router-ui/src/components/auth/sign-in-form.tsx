'use client';

import { useQuery } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader } from '@confidential-router/ui/components/card';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { MailCheck } from 'lucide-react';
import * as React from 'react';
import { AuthRequestError, type SocialProvider, signInWithMagicLink, signInWithProvider } from '../../lib/auth';
import { BootstrapForm } from './bootstrap-form';
import { SIGN_IN_OPTIONS_QUERY } from './operations';
import { GitHubIcon, GoogleIcon } from './provider-icons';

type Pending = SocialProvider | 'magic-link' | null;

/**
 * What to offer when the API cannot be reached.
 *
 * Everything, deliberately: the query failing says nothing about how this
 * deployment is configured, and a sign-in screen that hides every path because
 * one request timed out leaves the viewer with no way to even try. `bootstrap`
 * stays off — it is the one path that is normally unavailable, and offering it
 * blindly would suggest a fresh deployment where there may be none.
 */
const OFFER_EVERYTHING = { bootstrap: false, github: true, google: true, magicLink: true };

function messageOf(error: unknown): string {
  // Only errors this app raised are safe to render; anything else could be a
  // network stack detail with an internal hostname in it.
  return error instanceof AuthRequestError ? error.message : 'Sign-in failed. Please try again.';
}

export function SignInForm() {
  const [email, setEmail] = React.useState('');
  const [pending, setPending] = React.useState<Pending>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [linkSent, setLinkSent] = React.useState(false);
  const [bootstrapping, setBootstrapping] = React.useState(false);

  const { data, loading } = useQuery(SIGN_IN_OPTIONS_QUERY, { fetchPolicy: 'cache-and-network' });
  const options = data?.signInOptions ?? OFFER_EVERYTHING;

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

  return (
    <Card>
      <CardHeader>
        <h1 className="font-semibold leading-none">Sign in</h1>
        <CardDescription>
          {options.magicLink
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

            {providers.length > 0 && options.magicLink ? (
              <div className="flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 bg-border" />
                <span className="text-muted-foreground text-xs uppercase tracking-wide">or</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            ) : null}

            {options.magicLink ? (
              <form className="flex flex-col gap-2" onSubmit={(event) => void handleMagicLink(event)}>
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
                  {pending === 'magic-link' ? 'Sending…' : 'Email me a link'}
                </Button>
              </form>
            ) : null}

            {error ? (
              <p id="sign-in-error" role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}

            {/* A fresh deployment has no other way in, so this is the primary
                action there and a footnote nowhere else — the API only reports
                it while the token is configured and no account exists. */}
            {options.bootstrap ? (
              <Button
                variant={providers.length === 0 && !options.magicLink ? 'brand' : 'outline'}
                className="w-full"
                onClick={() => setBootstrapping(true)}
              >
                Have a bootstrap token?
              </Button>
            ) : null}

            {providers.length === 0 && !options.magicLink && !options.bootstrap ? (
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
