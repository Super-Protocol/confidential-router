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
import { requestPasswordReset } from '../../lib/auth';
import { messageOf } from './messages';
import { SIGN_IN_OPTIONS_QUERY } from './operations';

/**
 * A refused reset request. 429 is the per-address budget; 404 is a deployment
 * that has no reset at all, which the screen normally knows before anyone
 * types — this covers the answer changing between the two requests.
 */
const REQUEST_MESSAGES = {
  404: 'Password reset is not available on this deployment.',
  429: 'Too many reset requests from this network. Wait a minute and try again.',
};

/**
 * "Forgot password?" (SUP-269): mails a reset link.
 *
 * The confirmation is worded the way the router answers — "if there is an
 * account" — because the router answers identically whether or not there is
 * one, and a screen that claimed otherwise would be guessing.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);

  const { data, loading } = useQuery(SIGN_IN_OPTIONS_QUERY, { fetchPolicy: 'cache-and-network' });
  const settled = !loading || data !== undefined;
  // An unreachable API says nothing about the deployment, so the form stays up
  // and the request itself reports the failure.
  const offered = data?.signInOptions.passwordReset ?? true;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (caught) {
      setError(messageOf(caught, REQUEST_MESSAGES));
    } finally {
      setPending(false);
    }
  };

  if (sent) {
    return (
      <Card>
        <CardHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-brand-muted text-brand-emphasis">
            <MailCheck className="size-4" aria-hidden="true" />
          </div>
          <h1 className="font-semibold leading-none">Check your inbox</h1>
          <CardDescription>
            If <span className="font-medium text-foreground">{email}</span> has an account here, a reset link is on its
            way. It works once and expires within the hour.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Button variant="outline" className="w-full" onClick={() => setSent(false)}>
            Use a different address
          </Button>
          <Button variant="ghost" className="w-full" asChild>
            <Link href="/login">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <h1 className="font-semibold leading-none">Reset your password</h1>
        <CardDescription>
          {offered
            ? 'Enter the address you signed up with and we will mail you a link to choose a new password.'
            : 'This deployment cannot send mail, so a forgotten password cannot be reset here.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!settled ? (
          <div className="flex flex-col gap-2" data-testid="reset-options-loading">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : offered ? (
          <form className="flex flex-col gap-2" onSubmit={(event) => void handleSubmit(event)}>
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
              aria-describedby={error ? 'forgot-password-error' : undefined}
              aria-invalid={error !== null || undefined}
            />
            <Button type="submit" variant="brand" className="w-full" disabled={pending || email.length === 0}>
              {pending ? 'Sending…' : 'Email me a reset link'}
            </Button>
          </form>
        ) : null}

        {error ? (
          <p id="forgot-password-error" role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        <p className="text-center text-muted-foreground text-sm">
          Remembered it?{' '}
          <Link href="/login" className="font-medium text-foreground underline underline-offset-4">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
