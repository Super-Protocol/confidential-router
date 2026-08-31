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
import { KeyFormFields, keyFormOf, toUpdateInput, useKeyForm } from './key-form';
import { UPDATE_API_KEY } from './operations';
import type { ApiKeyRow, CatalogueModel } from './types';

export interface EditKeyDialogProps {
  /** Null when no key is being edited. */
  apiKey: ApiKeyRow | null;
  models: readonly CatalogueModel[];
  onOpenChange: (open: boolean) => void;
}

export function EditKeyDialog({ apiKey, models, onOpenChange }: EditKeyDialogProps) {
  // Remounting per key is what resets the form: a dialog reopened on a
  // different row must not carry the previous row's edits.
  return apiKey ? <EditKeyForm key={apiKey.id} apiKey={apiKey} models={models} onOpenChange={onOpenChange} /> : null;
}

function EditKeyForm({ apiKey, models, onOpenChange }: { apiKey: ApiKeyRow } & Omit<EditKeyDialogProps, 'apiKey'>) {
  const form = useKeyForm(keyFormOf(apiKey));
  const [failure, setFailure] = React.useState<string | null>(null);
  // The mutation returns the whole key, so Apollo writes the row itself.
  const [updateKey, { loading }] = useMutation(UPDATE_API_KEY);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    if (!form.validate()) return;

    try {
      await updateKey({ variables: { id: apiKey.id, input: toUpdateInput(form.values) } });
      onOpenChange(false);
    } catch (caught) {
      setFailure(errorMessageOf(caught));
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit {apiKey.name}</DialogTitle>
          <DialogDescription>
            Limits and scope apply from the next request. The key itself never changes — revoke and issue a new one to
            rotate it.
          </DialogDescription>
        </DialogHeader>

        <form id="edit-key-form" className="overflow-y-auto" onSubmit={(event) => void submit(event)}>
          <KeyFormFields
            values={form.values}
            onChange={form.setValues}
            errors={form.errors}
            models={models}
            idPrefix="edit-key"
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
          <Button type="submit" form="edit-key-form" disabled={loading}>
            {loading ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
