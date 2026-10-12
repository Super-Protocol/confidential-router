'use client';

import { useApolloClient, useMutation } from '@apollo/client/react';
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
import { errorMessageOf, fieldErrorsOf } from '../../lib/graphql-error';
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

  const [createKey] = useMutation(CREATE_API_KEY);
  const client = useApolloClient();
  /*
   * One flag for the whole handler, rather than the mutation's own `loading`.
   *
   * `loading` goes false the moment the key exists — which is now *before* the
   * dialog closes, because the list reload was moved out of the mutation. For
   * that window every control would be enabled again on an open dialog, and a
   * second click on "Create key" mints a second key whose secret is the only one
   * the reader ever sees. The first key would exist, unshown and unusable.
   */
  const [submitting, setSubmitting] = React.useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    if (!form.validate() || submitting) return;

    setSubmitting(true);
    try {
      const result = await createKey({ variables: { input: toCreateInput(form.values, workspaceId) } });
      const created = result.data?.createApiKey;
      if (!created) throw new Error('The key was not returned.');

      /*
       * The list is the screen's only copy of the workspace's keys, and the
       * mutation cannot know where a new row sorts, so the server is asked
       * again — after the key exists, and with its own `catch`. That `catch` is
       * what keeps a failed reload out of the handler's: the secret is shown
       * once and never again, so a reload that does not come back must cost the
       * reader a stale table, not the key they just made (SUP-295 item 2).
       */
      await client.refetchQueries({ include: [API_KEYS_QUERY] }).catch(() => undefined);

      onOpenChange(false);
      form.reset();
      onCreated(created.secret, created.key.name);
    } catch (caught) {
      if (!form.showServerErrors(fieldErrorsOf(caught))) {
        setFailure(errorMessageOf(caught));
      }
    } finally {
      setSubmitting(false);
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
            disabled={submitting}
          />
          {failure ? (
            <p role="alert" className="mt-4 text-destructive text-sm">
              {failure}
            </p>
          ) : null}
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="create-key-form" variant="brand" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create key'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
