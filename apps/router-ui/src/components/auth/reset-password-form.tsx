'use client';

import { useQuery } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader } from '@confidential-router/ui/components/card';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { AuthRequestError, resetPassword } from '../../lib/auth';
import { clearSignedIn } from '../../lib/signed-in-cookie';
import { messageOf } from './messages';
import { SIGN_IN_OPTIONS_QUERY } from './operations';

/** Better Auth's codes for a token it will not take, whatever the reason. */
const DEAD_TOKEN_CODES = new Set(['INVALID_TOKEN', 'USER_NOT_FOUND']);

type Outcome = 'form' | 'done' | 'dead-link';

/**
 * The page a reset mail links to (SUP-269): `/reset-password?token=…`.
 *
 * The token is read once from the URL and never shown. A dead link — used,
 * expired, or never valid — gets one explanation and a way to ask for a new
 * one rather than a form that can only fail again.
 */
export function ResetPasswordForm() {
  // Read once, the same way the sign-up form reads its invitation: the value
  // cannot change without a navigation, so `useSearchParams` and its Suspense
  // boundary would buy nothing.
  const [token] = React.useState(() => new URLSearchParams(globalThis.location?.search ?? '').get('token'));
  const [password, setPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [outcome, setOutcome] = React.useState<Outcome>(token ? 'form' : 'dead-link');

  const { data } = useQuery(SIGN_IN_OPTIONS_QUERY, { fetchPolicy: 'cache-and-network' });
  const minLength = data?.signInOptions.passwordMinLength ?? 0;
  const mismatch = confirmation.length > 0 && confirmation !== password;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || mismatch) return;
    setError(null);
    setPending(true);
    try {
      await resetPassword(token, password);
      // Every session the account had is gone, this browser's included if it
      // was one of them; its routing marker would only bounce it into a
      // console that answers "sign in" to every query.
      clearSignedIn();
      setOutcome('done');
    } catch (caught) {
      if (caught instanceof AuthRequestError && caught.code && DEAD_TOKEN_CODES.has(caught.code)) {
        setOutcome('dead-link');
      } else {
        setError(messageOf(caught, { 404: 'Password reset is not available on this deployment.' }));
      }
    } finally {
      setPending(false);
    }
  };

  if (outcome === 'done') {
    return (
      <Card>
        <CardHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-brand-muted text-brand-emphasis">
            <CircleCheck className="size-4" aria-hidden="true" />
          </div>
          <h1 className="font-semibold leading-none">Password changed</h1>
          <CardDescription>
            Sign in with your new password. Every other session on this account has been signed out.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="brand" className="w-full" asChild>
            <Link href="/login">Sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (outcome === 'dead-link') {
    return (
      <Card>
        <CardHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <TriangleAlert className="size-4" aria-hidden="true" />
          </div>
          <h1 className="font-semibold leading-none">This link no longer works</h1>
          <CardDescription>
            A reset link works once and expires after an hour. Ask for a new one and use the most recent mail.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Button variant="brand" className="w-full" asChild>
            <Link href="/forgot-password">Send a new link</Link>
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
        <h1 className="font-semibold leading-none">Choose a new password</h1>
        <CardDescription>Setting it signs this account out everywhere else.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form className="flex flex-col gap-2" onSubmit={(event) => void handleSubmit(event)}>
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={minLength || undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby="new-password-hint"
          />
          <p id="new-password-hint" className="text-muted-foreground text-xs">
            {minLength > 0 ? `At least ${minLength} characters.` : 'Use something long.'}
          </p>
          <Label htmlFor="confirm-password">Repeat it</Label>
          <Input
            id="confirm-password"
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            aria-describedby={mismatch ? 'confirm-password-error' : undefined}
            aria-invalid={mismatch || undefined}
          />
          {mismatch ? (
            <p id="confirm-password-error" className="text-destructive text-xs">
              The two passwords do not match.
            </p>
          ) : null}
          <Button
            type="submit"
            variant="brand"
            className="mt-2 w-full"
            disabled={pending || password.length < Math.max(minLength, 1) || confirmation !== password}
          >
            {pending ? 'Saving…' : 'Set new password'}
          </Button>
        </form>

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
