'use client';

import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader } from '@confidential-router/ui/components/card';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import { KeyRound } from 'lucide-react';
import * as React from 'react';
import { completeSignIn, signInWithBootstrapToken } from '../../lib/auth';
import { messageOf } from './messages';

/**
 * The two things the deployment's token does, which the router tells apart by
 * whether anyone has signed in yet (`signInOptions.bootstrap` and
 * `.adminRecovery`, never both):
 *
 *  - `setup` — the deployment is empty, and the token creates its first account;
 *  - `recovery` — that account exists, and the same token signs it back in
 *    (SUP-269). Sign-in is otherwise a code mailed to the address, so this is
 *    the administrator's way in when no code can be mailed.
 *
 * It is one endpoint and one field either way. What differs is every sentence
 * around it: "creates the first account" is false on a deployment that has one.
 */
export type BootstrapMode = 'setup' | 'recovery';

/**
 * A 404 means the token has nothing to open here, which reads differently in
 * the two modes. In `setup` it is the expected end of the path — someone else
 * got there first, or the operator is holding a token from a deployment that
 * has already been set up. In `recovery` it is a deployment whose token was
 * unset, or whose administrator account is gone, since the screen was drawn.
 * Either deserves a sentence rather than the generic failure text.
 */
const BOOTSTRAP_MESSAGES: Record<BootstrapMode, Record<number, string>> = {
  setup: {
    401: 'That token does not match this deployment’s bootstrap token.',
    404: 'This deployment already has an account. Sign in with it instead.',
  },
  recovery: {
    401: 'That token does not match this deployment’s first-sign-in token.',
    404: 'This deployment no longer accepts a first-sign-in token. Sign in another way.',
  },
};

const BOOTSTRAP_COPY: Record<
  BootstrapMode,
  { title: string; description: string; label: string; submit: string; submitting: string }
> = {
  setup: {
    title: 'Set up this deployment',
    description: 'Paste the bootstrap token from your deployment’s configuration. It creates the first account, once.',
    label: 'Bootstrap token',
    submit: 'Create the first account',
    submitting: 'Setting up…',
  },
  recovery: {
    title: 'Administrator sign-in',
    description:
      'Paste the first-sign-in token from your deployment’s configuration. It signs the administrator’s account back in, and no other.',
    label: 'First-sign-in token',
    submit: 'Sign in as administrator',
    submitting: 'Signing in…',
  },
};

export interface BootstrapFormProps {
  /** Returns to the ordinary sign-in card. */
  onCancel: () => void;
  /** Which of the token's two jobs this is. Defaults to the first sign-in. */
  mode?: BootstrapMode;
}

/**
 * Signing in with the deployment's own token: the first sign-in on a deployment
 * with no account, and the administrator's way back in afterwards.
 *
 * The token is the whole credential. On an empty deployment the router creates
 * the first account, its personal workspace and a session from it; afterwards
 * it opens a session for that one account and creates nothing. There is no
 * email field because the address is the deployment's (`auth.bootstrapEmail`) —
 * the operator controls it from the config, not from this form, which is what
 * keeps account creation single-use under concurrency.
 */
export function BootstrapForm({ onCancel, mode = 'setup' }: BootstrapFormProps) {
  const copy = BOOTSTRAP_COPY[mode];
  const [token, setToken] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await signInWithBootstrapToken(token);
      completeSignIn();
    } catch (caught) {
      setError(messageOf(caught, BOOTSTRAP_MESSAGES[mode]));
      setPending(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-brand-muted text-brand-emphasis">
          <KeyRound className="size-4" aria-hidden="true" />
        </div>
        <h1 className="font-semibold leading-none">{copy.title}</h1>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form className="flex flex-col gap-2" onSubmit={(event) => void handleSubmit(event)}>
          <Label htmlFor="bootstrap-token">{copy.label}</Label>
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
            {pending ? copy.submitting : copy.submit}
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
