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
import { Switch } from '@confidential-router/ui/components/switch';
import { Textarea } from '@confidential-router/ui/components/textarea';
import { CheckCircle2 } from 'lucide-react';
import * as React from 'react';
import type { ModelRequestSource } from '../../generated/graphql';
import { errorMessageOf } from '../../lib/graphql-error';
import { REQUEST_MODEL } from './operations';

/** Matches `RequestModelInput.model`'s `@Length(1, 200)`, so the server never has to say it. */
const MAX_MODEL_LENGTH = 200;
/** Matches `RequestModelInput.note`'s `@Length(0, 2000)`. */
const MAX_NOTE_LENGTH = 2000;

export interface RequestModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which screen opened it. Recorded, and reported as the event's `source`. */
  source: ModelRequestSource;
  /** The filter term to start from, when the dialog was opened from a search that found nothing. */
  initialModel?: string;
}

/**
 * "Request a model": the ask, and the confirmation that it landed.
 *
 * The dialog stays open on success and swaps its body for a receipt rather than
 * closing. Closing is what makes somebody submit five times wondering whether it
 * worked — there is no list for a new row to appear in, so the only evidence a
 * requester can have is a sentence naming what we recorded.
 *
 * `initialModel` is applied on each open rather than held in state, because the
 * empty-state button carries whatever is in the filter box *now*: a dialog that
 * remembered the first term would pre-fill the wrong model the second time.
 */
export function RequestModelDialog({ open, onOpenChange, source, initialModel = '' }: RequestModelDialogProps) {
  const [model, setModel] = React.useState(initialModel);
  const [note, setNote] = React.useState('');
  const [notify, setNotify] = React.useState(false);
  const [invalid, setInvalid] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [requested, setRequested] = React.useState<string | null>(null);

  const [requestModel, { loading }] = useMutation(REQUEST_MODEL);

  React.useEffect(() => {
    if (open) {
      setModel(initialModel);
      setNote('');
      setNotify(false);
      setInvalid(false);
      setFailure(null);
      setRequested(null);
    }
  }, [open, initialModel]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);

    const wanted = model.trim();
    if (wanted === '') {
      setInvalid(true);
      return;
    }
    setInvalid(false);

    try {
      const result = await requestModel({
        variables: { input: { model: wanted, note: note.trim() || null, notify, source } },
      });
      const receipt = result.data?.requestModel;
      if (!receipt) throw new Error('The request was not recorded.');
      setRequested(receipt.requestedModel);
    } catch (caught) {
      setFailure(errorMessageOf(caught));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{requested ? 'Request received' : 'Request a model'}</DialogTitle>
          <DialogDescription>
            {requested
              ? 'It is on the list we work from. We do not promise a date — what we promise is that the ask is counted.'
              : 'Tell us what to serve next. Every request is counted, so asking for something somebody else already asked for helps.'}
          </DialogDescription>
        </DialogHeader>

        {requested ? (
          <>
            <p className="flex items-start gap-2 text-sm" role="status">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-brand-emphasis" aria-hidden="true" />
              <span>
                We have recorded your request for <span className="font-medium">{requested}</span>
                {notify ? ', and will email you when it is served.' : '.'}
              </span>
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button type="button" variant="brand" onClick={() => setRequested(null)}>
                Request another
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <form
              id="request-model-form"
              className="space-y-4 overflow-y-auto"
              onSubmit={(event) => void submit(event)}
            >
              <div className="space-y-2">
                <Label htmlFor="request-model-name">Model name or Hugging Face id</Label>
                <Input
                  id="request-model-name"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  maxLength={MAX_MODEL_LENGTH}
                  placeholder="moonshotai/Kimi-K2-Instruct"
                  disabled={loading}
                  aria-invalid={invalid}
                  aria-describedby={invalid ? 'request-model-name-error' : undefined}
                />
                {invalid ? (
                  <p id="request-model-name-error" className="text-destructive text-sm">
                    Name the model you want — a Hugging Face id is the least ambiguous way.
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor="request-model-note">What would you use it for? (optional)</Label>
                <Textarea
                  id="request-model-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={MAX_NOTE_LENGTH}
                  rows={3}
                  placeholder="Long-context agentic runs we cannot send to a hosted API."
                  disabled={loading}
                />
                <p className="text-muted-foreground text-xs">
                  Read by us to decide what to serve next. It is never sent to analytics.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <Switch
                  id="request-model-notify"
                  checked={notify}
                  onCheckedChange={setNotify}
                  disabled={loading}
                  aria-label="Email me when this model is available"
                />
                <Label htmlFor="request-model-notify" className="font-normal">
                  Email me when it is available
                </Label>
              </div>

              {failure ? (
                <p role="alert" className="text-destructive text-sm">
                  {failure}
                </p>
              ) : null}
            </form>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                Cancel
              </Button>
              <Button type="submit" form="request-model-form" variant="brand" disabled={loading}>
                {loading ? 'Sending…' : 'Send request'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
