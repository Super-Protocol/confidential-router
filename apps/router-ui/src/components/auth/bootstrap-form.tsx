'use client';

import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader } from '@confidential-router/ui/components/card';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import { KeyRound } from 'lucide-react';
import * as React from 'react';
import { AuthRequestError, signInWithBootstrapToken } from '../../lib/auth';
import { publicConfig } from '../../lib/public-config';

/**
 * The router answers 404 once the deployment has an owner. That is the expected
 * end of this path — someone else got there first, or the operator is holding a
 * token from a deployment that has already been set up — so it deserves a
 * sentence rather than the generic failure text.
 */
function messageOf(error: unknown): string {
  if (!(error instanceof AuthRequestError)) {
    return 'Sign-in failed. Please try again.';
  }
  if (error.status === 404) {
    return 'This deployment already has an account. Sign in with it instead.';
  }
  if (error.status === 401) {
    return 'That token does not match this deployment’s bootstrap token.';
  }
  return error.message;
}

export interface BootstrapFormProps {
  /** Returns to the ordinary sign-in card. */
  onCancel: () => void;
}

/**
 * First sign-in on a deployment with no mailer and no OAuth app.
 *
 * The token is the whole credential: the router creates the first account, its
 * personal workspace and a session from it, and then the endpoint stops
 * existing. There is no email field because the address is the deployment's
 * (`auth.bootstrapEmail`) — the operator controls it from the config, not from
 * this form, which is what keeps the endpoint single-use under concurrency.
 */
export function BootstrapForm({ onCancel }: BootstrapFormProps) {
  const [token, setToken] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await signInWithBootstrapToken(token);
      // A full navigation rather than a router push: the session cookie was
      // just set on the API origin, and every cached Apollo result on this page
      // was fetched without one.
      window.location.assign(publicConfig().authCallbackUrl);
    } catch (caught) {
      setError(messageOf(caught));
      setPending(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-brand-muted text-brand-emphasis">
          <KeyRound className="size-4" aria-hidden="true" />
        </div>
        <h1 className="font-semibold leading-none">Set up this deployment</h1>
        <CardDescription>
          Paste the bootstrap token from your deployment’s configuration. It creates the first account, once.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form className="flex flex-col gap-2" onSubmit={(event) => void handleSubmit(event)}>
          <Label htmlFor="bootstrap-token">Bootstrap token</Label>
          <Input
            id="bootstrap-token"
            name="token"
            type="password"
            autoComplete="off"
            required
            className="font-mono"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            aria-describedby={error ? 'bootstrap-error' : undefined}
            aria-invalid={error !== null || undefined}
          />
          <Button type="submit" variant="brand" className="w-full" disabled={pending || token.length === 0}>
            {pending ? 'Setting up…' : 'Create the first account'}
          </Button>
        </form>

        {error ? (
          <p id="bootstrap-error" role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        <Button variant="outline" className="w-full" onClick={onCancel} disabled={pending}>
          Back to sign in
        </Button>
      </CardContent>
    </Card>
  );
}
