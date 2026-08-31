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
import { EMPTY_KEY_FORM, KeyFormFields, toCreateInput, useKeyForm } from './key-form';
import { API_KEYS_QUERY, CREATE_API_KEY } from './operations';
import type { CatalogueModel } from './types';

export interface CreateKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  models: readonly CatalogueModel[];
  /** Handed the plaintext exactly once, for the show-once dialog. */
  onCreated: (secret: string, name: string) => void;
}

export function CreateKeyDialog({ open, onOpenChange, workspaceId, models, onCreated }: CreateKeyDialogProps) {
  const form = useKeyForm(EMPTY_KEY_FORM);
  const [failure, setFailure] = React.useState<string | null>(null);

  const [createKey, { loading }] = useMutation(CREATE_API_KEY, {
    // The list is the screen's only copy of the workspace's keys, and the
    // mutation cannot know where a new row sorts, so let the server say.
    refetchQueries: [{ query: API_KEYS_QUERY, variables: { workspaceId } }],
    awaitRefetchQueries: true,
  });

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    if (!form.validate()) return;

    try {
      const result = await createKey({ variables: { input: toCreateInput(form.values, workspaceId) } });
      const created = result.data?.createApiKey;
      if (!created) throw new Error('The key was not returned.');

      onOpenChange(false);
      form.reset();
      onCreated(created.secret, created.key.name);
    } catch (caught) {
      setFailure(errorMessageOf(caught));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New API key</DialogTitle>
          <DialogDescription>
            The key is shown once, right after it is created. It is stored hashed, so it cannot be shown again.
          </DialogDescription>
        </DialogHeader>

        <form id="create-key-form" className="overflow-y-auto" onSubmit={(event) => void submit(event)}>
          <KeyFormFields
            values={form.values}
            onChange={form.setValues}
            errors={form.errors}
            models={models}
            idPrefix="create-key"
            disabled={loading}
          />
          {failure ? (
            <p role="alert" className="mt-4 text-destructive text-sm">
              {failure}
            </p>
          ) : null}
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" form="create-key-form" variant="brand" disabled={loading}>
            {loading ? 'Creating…' : 'Create key'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
