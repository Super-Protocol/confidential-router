'use client';

import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader } from '@confidential-router/ui/components/card';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import { MailCheck } from 'lucide-react';
import * as React from 'react';
import { AuthRequestError, type SocialProvider, signInWithMagicLink, signInWithProvider } from '../../lib/auth';
import { GitHubIcon, GoogleIcon } from './provider-icons';

type Pending = SocialProvider | 'magic-link' | null;

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

  return (
    <Card>
      <CardHeader>
        <h1 className="font-semibold leading-none">Sign in</h1>
        <CardDescription>No passwords. Use a provider, or have a one-time link mailed to you.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Button
            variant="outline"
            className="w-full"
            disabled={pending !== null}
            onClick={() => void handleProvider('github')}
          >
            <GitHubIcon className="size-4" />
            {pending === 'github' ? 'Redirecting…' : 'Continue with GitHub'}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            disabled={pending !== null}
            onClick={() => void handleProvider('google')}
          >
            <GoogleIcon className="size-4" />
            {pending === 'google' ? 'Redirecting…' : 'Continue with Google'}
          </Button>
        </div>

        <div className="flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-border" />
          <span className="text-muted-foreground text-xs uppercase tracking-wide">or</span>
          <span className="h-px flex-1 bg-border" />
        </div>

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
          <Button type="submit" variant="brand" className="w-full" disabled={pending !== null || email.length === 0}>
            {pending === 'magic-link' ? 'Sending…' : 'Email me a link'}
          </Button>
        </form>

        {error ? (
          <p id="sign-in-error" role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
