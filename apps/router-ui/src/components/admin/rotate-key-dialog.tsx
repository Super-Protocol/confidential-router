'use client';

import { useMutation } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@confidential-router/ui/components/dialog';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import * as React from 'react';
import type { ExternalEndpointFieldsFragment } from '../../generated/graphql';
import { connectionLinkRefusalMessage, parseConnectionLink } from '../../lib/connection-link';
import { errorMessageOf } from '../../lib/graphql-error';
import { ROTATE_EXTERNAL_ENDPOINT_KEY } from './operations';

export interface RotateKeyDialogProps {
  endpoint: ExternalEndpointFieldsFragment | null;
  onOpenChange: (open: boolean) => void;
}

/*
 * Note for the caller: mount this with `key={endpoint?.id}`. The typed key is
 * component state, and a dialog reused across two endpoints would otherwise
 * carry one upstream's credential into the other's form. A remount is cheaper to
 * reason about than an effect that clears it.
 */

/**
 * Replace the upstream credential.
 *
 * Rotation is a write and not an edit: the stored key is a sealed envelope no
 * read path opens (threat T15), so there is nothing to pre-fill and nothing to
 * show afterwards but the new prefix. A freshly issued connection link is
 * accepted here too, because that is the form a rotated upstream key usually
 * arrives in — only its `key` is used; base URL and model are left alone.
 */
export function RotateKeyDialog({ endpoint, onOpenChange }: RotateKeyDialogProps) {
  const [apiKey, setApiKey] = React.useState('');
  const [failure, setFailure] = React.useState<string | null>(null);

  const [rotate, { loading }] = useMutation(ROTATE_EXTERNAL_ENDPOINT_KEY);

  if (!endpoint) return null;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);

    const typed = apiKey.trim();
    if (typed === '') {
      setFailure('Enter the new key.');
      return;
    }

    // A pasted connection link is a key wrapped in a URL; anything else is the
    // key itself. Checking for the scheme first keeps a link from being stored
    // verbatim as a credential.
    let secret = typed;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(typed)) {
      const parsed = parseConnectionLink(typed);
      if (!parsed.ok) {
        setFailure(connectionLinkRefusalMessage(parsed.reason));
        return;
      }
      secret = parsed.link.apiKey;
    }

    try {
      await rotate({ variables: { id: endpoint.id, input: { apiKey: secret } } });
      onOpenChange(false);
      setApiKey('');
    } catch (caught) {
      setFailure(errorMessageOf(caught));
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Rotate the key for {endpoint.name}</DialogTitle>
          <DialogDescription>
            The current key is stored encrypted and cannot be read back — it shows as{' '}
            <span className="font-mono">{endpoint.apiKeyPrefix ?? '—'}…</span>. Saving replaces it; in-flight requests
            finish on the old one.
          </DialogDescription>
        </DialogHeader>

        <form id="rotate-key-form" onSubmit={(event) => void submit(event)}>
          <Label htmlFor="rotate-api-key">New upstream API key</Label>
          <Input
            id="rotate-api-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            aria-describedby="rotate-api-key-help"
            disabled={loading}
            autoComplete="off"
          />
          <p id="rotate-api-key-help" className="mt-1 text-muted-foreground text-xs">
            A fresh connection link works too — only its key is taken.
          </p>
          {failure ? (
            <p role="alert" className="mt-3 text-destructive text-sm">
              {failure}
            </p>
          ) : null}
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" form="rotate-key-form" variant="brand" disabled={loading}>
            {loading ? 'Rotating…' : 'Rotate key'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
