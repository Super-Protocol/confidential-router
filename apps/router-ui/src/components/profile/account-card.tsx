'use client';

import { useMutation } from '@apollo/client/react';
import { Avatar, AvatarFallback, AvatarImage } from '@confidential-router/ui/components/avatar';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent } from '@confidential-router/ui/components/card';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import * as React from 'react';
import { toast } from 'sonner';
import { formatDate } from '../../lib/format';
import { errorMessageOf } from '../../lib/graphql-error';
import { UPDATE_PROFILE } from './operations';

export interface AccountCardProps {
  name: string | null;
  email: string;
  avatarUrl: string | null;
  /** When the account was created — "member since". */
  createdAt: string;
}

/** Initials for the avatar fallback; the email is the only thing always present. */
function initialsOf(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return (parts[0]?.[0] ?? '?').concat(parts.length > 1 ? (parts[1]?.[0] ?? '') : '').toUpperCase();
}

/**
 * Identity, and the one thing about it the console can change.
 *
 * The email is read-only: it is the identity Better Auth signed the viewer in
 * with (ADR-004), and changing it would be an account move, not a profile edit.
 */
export function AccountCard({ name, email, avatarUrl, createdAt }: AccountCardProps) {
  const [value, setValue] = React.useState(name ?? '');
  const [error, setError] = React.useState<string | null>(null);
  const [updateProfile, { loading }] = useMutation(UPDATE_PROFILE);

  const stored = React.useRef(name);
  if (stored.current !== name) {
    stored.current = name;
    setValue(name ?? '');
    setError(null);
  }

  const dirty = value.trim() !== (name ?? '').trim();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (value.trim() === '') {
      setError('A blank name is not a name. Enter what the console should call you.');
      return;
    }
    setError(null);

    try {
      await updateProfile({ variables: { input: { name: value.trim() } } });
      toast.success('Profile updated.');
    } catch (cause) {
      toast.error(errorMessageOf(cause, 'The profile could not be saved.'));
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <div className="flex items-center gap-4">
          <Avatar className="size-14">
            {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
            <AvatarFallback>{initialsOf(name, email)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate font-semibold text-lg">{name ?? email}</p>
            <p className="truncate text-muted-foreground text-sm">{email}</p>
            <p className="text-muted-foreground text-sm">Member since {formatDate(createdAt)}</p>
          </div>
        </div>

        <form className="flex-1 space-y-2 sm:max-w-sm" onSubmit={submit}>
          <Label htmlFor="profile-name">Display name</Label>
          <div className="flex gap-2">
            <Input
              id="profile-name"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Your name"
              aria-invalid={error !== null || undefined}
              aria-describedby={error ? 'profile-name-error' : undefined}
            />
            <Button type="submit" variant="outline" disabled={loading || !dirty}>
              {loading ? 'Saving…' : 'Save'}
            </Button>
          </div>
          {error ? (
            <p id="profile-name-error" className="text-destructive text-xs">
              {error}
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">Shown in the console. Your sign-in address does not change.</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
