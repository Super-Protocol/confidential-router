'use client';

import { useQuery } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader } from '@confidential-router/ui/components/card';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import Link from 'next/link';
import * as React from 'react';
import { signUpWithPassword } from '../../lib/auth';
import { publicConfig } from '../../lib/public-config';
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
 * Creating an account on a deployment that cannot send mail.
 *
 * No verification round trip and no reset link: the address is never proven,
 * because proving it needs a mailer and the whole point of this path is not
 * having one. It exists so that a deployment whose bootstrap token created one
 * administrator can be used by a second person (SUP-112).
 */
export function SignUpForm() {
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const { data, loading } = useQuery(SIGN_IN_OPTIONS_QUERY, { fetchPolicy: 'cache-and-network' });
  const settled = !loading || data !== undefined;
  // Unlike the sign-in screen, a failed query is not a reason to offer this:
  // there is nothing to fall back to, and a form that can only 404 is worse
  // than a sentence saying where to go instead.
  const offered = data?.signInOptions.password ?? false;
  const minLength = data?.signInOptions.passwordMinLength ?? 0;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await signUpWithPassword({ email, password, name });
      // The session cookie was just set on the API origin, so this is a full
      // navigation rather than a router push.
      window.location.assign(publicConfig().authCallbackUrl);
    } catch (caught) {
      setError(messageOf(caught, SIGN_UP_MESSAGES));
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
          Your prompts are metered, never stored. There is no confirmation mail on this deployment — the account works
          from the moment you create it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
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
            At least {minLength} characters. There is no password reset on this deployment, so use something you will
            not lose.
          </p>
          <Button
            type="submit"
            variant="brand"
            className="w-full"
            disabled={pending || email.length === 0 || password.length < minLength}
          >
            {pending ? 'Creating…' : 'Create account'}
          </Button>
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
