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
import * as React from 'react';
import { errorMessageOf } from '../../lib/graphql-error';
import { REVOKE_API_KEY } from './operations';
import type { ApiKeyRow } from './types';

export interface RevokeKeyDialogProps {
  /** Null when nothing is being revoked. */
  apiKey: ApiKeyRow | null;
  onOpenChange: (open: boolean) => void;
}

export function RevokeKeyDialog({ apiKey, onOpenChange }: RevokeKeyDialogProps) {
  const [failure, setFailure] = React.useState<string | null>(null);
  const [revokeKey, { loading }] = useMutation(REVOKE_API_KEY);

  const revoke = async () => {
    if (!apiKey) return;
    setFailure(null);
    try {
      await revokeKey({ variables: { id: apiKey.id } });
      onOpenChange(false);
    } catch (caught) {
      setFailure(errorMessageOf(caught));
    }
  };

  return (
    <Dialog open={apiKey !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke {apiKey?.name}?</DialogTitle>
          <DialogDescription>
            The next request made with this key is refused. Revoking cannot be undone, and generations already metered
            against it stay in the log.
          </DialogDescription>
        </DialogHeader>

        {failure ? (
          <p role="alert" className="text-destructive text-sm">
            {failure}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={() => void revoke()} disabled={loading}>
            {loading ? 'Revoking…' : 'Revoke key'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
