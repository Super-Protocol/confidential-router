'use client';

import { Button } from '@confidential-router/ui/components/button';
import { CodeBlock } from '@confidential-router/ui/components/code-block';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@confidential-router/ui/components/dialog';
import { TriangleAlert } from 'lucide-react';
import { WiringSnippet } from './wiring-snippet';

export interface CreatedKeyDialogProps {
  /** The plaintext key. Null closes the dialog — it is never persisted anywhere. */
  secret: string | null;
  name: string;
  /** First model in the catalogue, so the snippet is runnable as pasted. */
  model?: string;
  onClose: () => void;
}

/**
 * The one and only time the plaintext key exists in the browser. It is shown
 * with the wiring snippet already filled in, because the next thing anyone does
 * with a new key is paste it into a client.
 */
export function CreatedKeyDialog({ secret, name, model, onClose }: CreatedKeyDialogProps) {
  return (
    <Dialog open={secret !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Copy your key now</DialogTitle>
          <DialogDescription>
            <span className="flex items-start gap-2 text-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                <span className="font-medium">{name}</span> is stored hashed. This is the only time it can be shown —
                closing this dialog loses it for good.
              </span>
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 overflow-y-auto">
          {secret ? <CodeBlock code={secret} copyLabel="Copy the API key" data-testid="created-key-secret" /> : null}

          <div className="space-y-2">
            <h2 className="font-medium text-sm">Wire it up</h2>
            <p className="text-muted-foreground text-sm">
              One base-URL swap: point the OpenAI SDK at the Gatekeeper running on your machine. The SDK, the model slug
              and the key are unchanged.
            </p>
            {secret ? <WiringSnippet apiKey={secret} model={model} /> : null}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
