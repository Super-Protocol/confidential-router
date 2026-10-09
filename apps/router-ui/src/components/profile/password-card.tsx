'use client';

import { useMutation } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import * as React from 'react';
import { toast } from 'sonner';
import { errorMessageOf } from '../../lib/graphql-error';
import { SET_PASSWORD } from './operations';

export interface PasswordCardProps {
  /** `auth.password.minLength`, read back from the router so the rule shown is the one enforced. */
  minLength: number;
  /** A forgotten password can be reset by mail here (SUP-269), so the hint need not warn that it cannot. */
  resettable?: boolean;
}

/**
 * A first password, for an account that was created without one (SUP-267).
 *
 * The bootstrap token, a magic link and OAuth all sign in without a password.
 * On a deployment with no mailer and no OAuth app the session that came with
 * the account is then the only way back in, and it expires. Rendered only while
 * the account has no password and the deployment signs in with one; once set,
 * changing it is not this card's job.
 */
export function PasswordCard({ minLength, resettable = false }: PasswordCardProps) {
  const [password, setPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [save, { loading }] = useMutation(SET_PASSWORD);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (password !== confirmation) {
      setError('The two passwords do not match.');
      return;
    }
    setError(null);

    try {
      await save({ variables: { input: { password } } });
      toast.success('Password set. You can now sign in with your email and this password.');
    } catch (cause) {
      setError(errorMessageOf(cause, 'The password could not be set.'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set a password</CardTitle>
        <CardDescription>
          This account has no password, so this browser session is your only way in. Set one to sign in again after it
          ends.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-3 sm:max-w-sm" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="profile-password">New password</Label>
            <Input
              id="profile-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={error !== null || undefined}
              aria-describedby="profile-password-hint"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-password-confirmation">Confirm password</Label>
            <Input
              id="profile-password-confirmation"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              aria-invalid={error !== null || undefined}
              aria-describedby="profile-password-hint"
            />
          </div>
          {error ? (
            <p id="profile-password-hint" className="text-destructive text-xs">
              {error}
            </p>
          ) : (
            <p id="profile-password-hint" className="text-muted-foreground text-xs">
              {resettable
                ? `At least ${minLength} characters.`
                : `At least ${minLength} characters. There is no password reset on this deployment, so keep it somewhere safe.`}
            </p>
          )}
          <Button type="submit" disabled={loading || password.length < minLength || confirmation.length === 0}>
            {loading ? 'Saving…' : 'Set password'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
