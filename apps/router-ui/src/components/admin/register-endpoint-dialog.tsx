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
import { ClipboardPaste, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { connectionLinkRefusalMessage, parseConnectionLink } from '../../lib/connection-link';
import { errorMessageOf } from '../../lib/graphql-error';
import {
  EMPTY_ENDPOINT_FORM,
  EMPTY_MODEL,
  type EndpointFormErrors,
  type EndpointFormValues,
  toRegisterInput,
  validateEndpointForm,
} from './endpoint-form';
import { EXTERNAL_ENDPOINTS_QUERY, REGISTER_EXTERNAL_ENDPOINT } from './operations';

export interface RegisterEndpointDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the drawer on the new endpoint, so the evidence summary is seen at registration (ruling 1). */
  onRegistered: (endpointId: string) => void;
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-destructive text-xs">
      {message}
    </p>
  );
}

/**
 * Register an external upstream: either by pasting the connection link the
 * upstream's marketplace listing emits, or by typing the four things that link
 * carries.
 *
 * The paste path is a convenience and nothing more — it fills fields, and the
 * admin still sets the price and submits (decision 4; `docs/contracts/connection-link.md`).
 * A producer that could set the price would be setting what this deployment
 * charges its own users.
 */
export function RegisterEndpointDialog({ open, onOpenChange, onRegistered }: RegisterEndpointDialogProps) {
  const [values, setValues] = React.useState<EndpointFormValues>(EMPTY_ENDPOINT_FORM);
  const [errors, setErrors] = React.useState<EndpointFormErrors>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [link, setLink] = React.useState('');
  const [linkRefusal, setLinkRefusal] = React.useState<string | null>(null);
  const [linkAccepted, setLinkAccepted] = React.useState(false);

  const [register, { loading }] = useMutation(REGISTER_EXTERNAL_ENDPOINT, {
    // The list is the screen's only copy, and the new row's place in it is the
    // server's to decide.
    refetchQueries: [{ query: EXTERNAL_ENDPOINTS_QUERY }],
    awaitRefetchQueries: true,
  });

  const reset = () => {
    setValues(EMPTY_ENDPOINT_FORM);
    setErrors({});
    setFailure(null);
    setLink('');
    setLinkRefusal(null);
    setLinkAccepted(false);
  };

  const setModel = (index: number, patch: Partial<EndpointFormValues['models'][number]>) => {
    setValues((current) => ({
      ...current,
      models: current.models.map((model, at) => (at === index ? { ...model, ...patch } : model)),
    }));
  };

  const applyLink = () => {
    const result = parseConnectionLink(link);
    if (!result.ok) {
      setLinkAccepted(false);
      setLinkRefusal(connectionLinkRefusalMessage(result.reason));
      return;
    }

    const { baseUrl, modelId, apiKey, suggestedName } = result.link;
    setValues((current) => ({
      name: current.name.trim() === '' ? suggestedName : current.name,
      baseUrl,
      apiKey,
      models: [
        { ...(current.models[0] ?? EMPTY_MODEL), id: modelId, name: modelId, upstreamModel: modelId },
        ...current.models.slice(1),
      ],
    }));
    setErrors({});
    setLinkRefusal(null);
    setLinkAccepted(true);
    // The link is a credential. Clearing the field keeps it out of the form the
    // next screenshot catches (`docs/contracts/connection-link.md`).
    setLink('');
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);

    const found = validateEndpointForm(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    try {
      const result = await register({ variables: { input: toRegisterInput(values) } });
      const registered = result.data?.registerExternalEndpoint;
      if (!registered) throw new Error('The endpoint was not returned.');

      onOpenChange(false);
      reset();
      onRegistered(registered.id);
    } catch (caught) {
      setFailure(errorMessageOf(caught));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add external endpoint</DialogTitle>
          <DialogDescription>
            A model served by another deployment. This router fetches its evidence, checks the measurement against the
            trust list and pins its certificate before any prompt is proxied — nothing routes until that succeeds.
          </DialogDescription>
        </DialogHeader>

        <section aria-label="Connection link" className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <Label htmlFor="connection-link" className="flex items-center gap-1.5">
            <ClipboardPaste className="size-3.5" aria-hidden="true" />
            Paste a connection link
          </Label>
          <div className="flex gap-2">
            <Input
              id="connection-link"
              value={link}
              onChange={(event) => {
                setLink(event.target.value);
                setLinkRefusal(null);
              }}
              placeholder="https://host.example/v1#key=…&model=…"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="connection-link-help"
              aria-invalid={linkRefusal !== null}
            />
            <Button type="button" variant="outline" onClick={applyLink} disabled={link.trim() === '' || loading}>
              Fill in
            </Button>
          </div>
          <p id="connection-link-help" className="text-muted-foreground text-xs">
            Model-serving marketplace apps emit one as a secret output. It carries the key after the <code>#</code>, so
            it never reaches a server log — and it never carries a price: that is yours to set below.
          </p>
          <FieldError id="connection-link-error" message={linkRefusal ?? undefined} />
          {linkAccepted ? (
            <p role="status" className="text-success text-xs">
              Filled in from the link. Set the prices and confirm.
            </p>
          ) : null}
        </section>

        <form id="register-endpoint-form" className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="endpoint-name">Name</Label>
              <Input
                id="endpoint-name"
                value={values.name}
                onChange={(event) => setValues((current) => ({ ...current, name: event.target.value }))}
                aria-describedby={errors.name ? 'endpoint-name-error' : 'endpoint-name-help'}
                aria-invalid={Boolean(errors.name)}
                disabled={loading}
                autoComplete="off"
              />
              <p id="endpoint-name-help" className="mt-1 text-muted-foreground text-xs">
                Lower-case, hyphenated. Cannot be changed later — it is also the egress verifier's key for this
                upstream.
              </p>
              <FieldError id="endpoint-name-error" message={errors.name} />
            </div>

            <div>
              <Label htmlFor="endpoint-base-url">Base URL</Label>
              <Input
                id="endpoint-base-url"
                value={values.baseUrl}
                onChange={(event) => setValues((current) => ({ ...current, baseUrl: event.target.value }))}
                placeholder="https://host.example"
                aria-describedby={errors.baseUrl ? 'endpoint-base-url-error' : undefined}
                aria-invalid={Boolean(errors.baseUrl)}
                disabled={loading}
                autoComplete="off"
              />
              <FieldError id="endpoint-base-url-error" message={errors.baseUrl} />
            </div>
          </div>

          <div>
            <Label htmlFor="endpoint-api-key">Upstream API key</Label>
            <Input
              id="endpoint-api-key"
              type="password"
              value={values.apiKey}
              onChange={(event) => setValues((current) => ({ ...current, apiKey: event.target.value }))}
              aria-describedby={errors.apiKey ? 'endpoint-api-key-error' : 'endpoint-api-key-help'}
              aria-invalid={Boolean(errors.apiKey)}
              disabled={loading}
              autoComplete="off"
            />
            <p id="endpoint-api-key-help" className="mt-1 text-muted-foreground text-xs">
              The ordinary LLM key the upstream issued you. Stored encrypted and never shown again — afterwards this
              screen can only show its first characters.
            </p>
            <FieldError id="endpoint-api-key-error" message={errors.apiKey} />
          </div>

          <fieldset className="space-y-3">
            <legend className="font-medium text-sm">Models and prices</legend>
            <p className="text-muted-foreground text-xs">
              Prices are per 1M tokens in USD and are frozen per generation, like any built-in model.
            </p>
            <FieldError id="endpoint-models-error" message={errors.models} />

            {values.models.map((model, index) => (
              // The row index is the identity here: these rows have no id until
              // they are submitted, and reordering is not offered.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <div key={index} className="space-y-3 rounded-lg border p-3" data-testid={`model-row-${index}`}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor={`model-${index}-id`}>Model id on this router</Label>
                    <Input
                      id={`model-${index}-id`}
                      value={model.id}
                      onChange={(event) => setModel(index, { id: event.target.value })}
                      aria-invalid={Boolean(errors[`models.${index}.id`])}
                      disabled={loading}
                      autoComplete="off"
                    />
                    <FieldError id={`model-${index}-id-error`} message={errors[`models.${index}.id`]} />
                  </div>
                  <div>
                    <Label htmlFor={`model-${index}-upstream`}>Model id upstream</Label>
                    <Input
                      id={`model-${index}-upstream`}
                      value={model.upstreamModel}
                      onChange={(event) => setModel(index, { upstreamModel: event.target.value })}
                      aria-invalid={Boolean(errors[`models.${index}.upstreamModel`])}
                      disabled={loading}
                      autoComplete="off"
                    />
                    <FieldError
                      id={`model-${index}-upstream-error`}
                      message={errors[`models.${index}.upstreamModel`]}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`model-${index}-name`}>Display name</Label>
                    <Input
                      id={`model-${index}-name`}
                      value={model.name}
                      onChange={(event) => setModel(index, { name: event.target.value })}
                      aria-invalid={Boolean(errors[`models.${index}.name`])}
                      disabled={loading}
                      autoComplete="off"
                    />
                    <FieldError id={`model-${index}-name-error`} message={errors[`models.${index}.name`]} />
                  </div>
                  <div>
                    <Label htmlFor={`model-${index}-context`}>Context length</Label>
                    <Input
                      id={`model-${index}-context`}
                      inputMode="numeric"
                      value={model.contextLength}
                      onChange={(event) => setModel(index, { contextLength: event.target.value })}
                      aria-invalid={Boolean(errors[`models.${index}.contextLength`])}
                      disabled={loading}
                      autoComplete="off"
                    />
                    <FieldError id={`model-${index}-context-error`} message={errors[`models.${index}.contextLength`]} />
                  </div>
                  <div>
                    <Label htmlFor={`model-${index}-prompt-price`}>Prompt, USD / 1M</Label>
                    <Input
                      id={`model-${index}-prompt-price`}
                      inputMode="decimal"
                      value={model.promptPer1m}
                      onChange={(event) => setModel(index, { promptPer1m: event.target.value })}
                      aria-invalid={Boolean(errors[`models.${index}.promptPer1m`])}
                      disabled={loading}
                      autoComplete="off"
                    />
                    <FieldError
                      id={`model-${index}-prompt-price-error`}
                      message={errors[`models.${index}.promptPer1m`]}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`model-${index}-completion-price`}>Completion, USD / 1M</Label>
                    <Input
                      id={`model-${index}-completion-price`}
                      inputMode="decimal"
                      value={model.completionPer1m}
                      onChange={(event) => setModel(index, { completionPer1m: event.target.value })}
                      aria-invalid={Boolean(errors[`models.${index}.completionPer1m`])}
                      disabled={loading}
                      autoComplete="off"
                    />
                    <FieldError
                      id={`model-${index}-completion-price-error`}
                      message={errors[`models.${index}.completionPer1m`]}
                    />
                  </div>
                </div>

                {values.models.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={loading}
                    onClick={() =>
                      setValues((current) => ({
                        ...current,
                        models: current.models.filter((_, at) => at !== index),
                      }))
                    }
                  >
                    <Trash2 aria-hidden="true" />
                    Remove model
                  </Button>
                ) : null}
              </div>
            ))}

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => setValues((current) => ({ ...current, models: [...current.models, { ...EMPTY_MODEL }] }))}
            >
              <Plus aria-hidden="true" />
              Add another model
            </Button>
          </fieldset>

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
          <Button type="submit" form="register-endpoint-form" variant="brand" disabled={loading}>
            {loading ? 'Registering…' : 'Register endpoint'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
