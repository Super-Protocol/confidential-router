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
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import * as React from 'react';
import { classifyEndpointSource, type EndpointSource } from '../../lib/endpoint-source';
import { errorMessageOf } from '../../lib/graphql-error';
import { DiscoveryPanel } from './discovery-panel';
import {
  EMPTY_ENDPOINT_FORM,
  EMPTY_MODEL,
  type EndpointFormErrors,
  type EndpointFormValues,
  toRegisterInput,
  validateEndpointForm,
} from './endpoint-form';
import { describedBy, FieldError, FormField, ModelFields } from './form-field';
import { EXTERNAL_ENDPOINTS_QUERY, REGISTER_EXTERNAL_ENDPOINT } from './operations';

export interface RegisterEndpointDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the drawer on the new endpoint, so the evidence summary is seen at registration (ruling 1). */
  onRegistered: (endpointId: string) => void;
}

/**
 * Which form the dialog is showing.
 *
 * - `start`: only the one field.
 * - `discover`: a bare URL was pasted — name and key, then attest-then-list.
 * - `typed`: a connection link filled everything, or the admin chose to type
 *   the models by hand; the full form, submitted in one go.
 */
type Mode = 'start' | 'discover' | 'typed';

const SOURCE_HELP = (
  <>
    The model’s base URL — or the <strong>connection link</strong> from the model deployment’s <em>Outputs</em> panel,
    which carries the URL, key and model in one string. A link keeps the key after the <code>#</code>, so it never
    reaches a server log; it never carries a price.
  </>
);

/**
 * Register an external upstream (SUP-249).
 *
 * One field, two paths, told apart by what was pasted:
 *
 *  - **A bare URL** is the primary path. The admin adds the key; the router
 *    registers the endpoint with no models, attests it — evidence, trust list,
 *    certificate pin — and only then lists `/v1/models` through the attested
 *    egress. The admin ticks what to publish and sets prices.
 *  - **A connection link** is the fast path: it fills name, URL, key and model,
 *    and the admin sets the price and submits (decision 4;
 *    `docs/contracts/connection-link.md`). A producer that could set the price
 *    would be setting what this deployment charges its own users.
 */
export function RegisterEndpointDialog({ open, onOpenChange, onRegistered }: RegisterEndpointDialogProps) {
  const [mode, setMode] = React.useState<Mode>('start');
  const [source, setSource] = React.useState('');
  const [sourceTouched, setSourceTouched] = React.useState(false);
  const [linkAccepted, setLinkAccepted] = React.useState(false);
  /** Once the admin types a name, a later paste no longer overwrites it. */
  const [nameEdited, setNameEdited] = React.useState(false);
  const [values, setValues] = React.useState<EndpointFormValues>(EMPTY_ENDPOINT_FORM);
  const [errors, setErrors] = React.useState<EndpointFormErrors>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  /** Set once a discovery registration went through; the panel takes over from there. */
  const [registered, setRegistered] = React.useState<{ id: string; name: string } | null>(null);

  const [register, { loading }] = useMutation(REGISTER_EXTERNAL_ENDPOINT, {
    // The list is the screen's only copy, and the new row's place in it is the
    // server's to decide.
    refetchQueries: [{ query: EXTERNAL_ENDPOINTS_QUERY }],
    awaitRefetchQueries: true,
  });

  const reset = () => {
    setMode('start');
    setSource('');
    setSourceTouched(false);
    setLinkAccepted(false);
    setNameEdited(false);
    setValues(EMPTY_ENDPOINT_FORM);
    setErrors({});
    setFailure(null);
    setRegistered(null);
  };

  const classified: EndpointSource = classifyEndpointSource(source);
  const sourceError =
    classified.kind === 'refused' && (classified.urgent || sourceTouched) ? classified.message : undefined;

  const onSourceChange = (next: string) => {
    setSource(next);
    setFailure(null);
    const result = classifyEndpointSource(next);
    if (result.kind === 'link') {
      const { baseUrl, modelId, apiKey, suggestedName } = result.link;
      setValues((current) => ({
        name: nameEdited ? current.name : suggestedName,
        baseUrl,
        apiKey,
        models: [
          { ...(current.models[0] ?? EMPTY_MODEL), id: modelId, name: modelId, upstreamModel: modelId },
          ...current.models.slice(1),
        ],
      }));
      setErrors({});
      setLinkAccepted(true);
      setMode('typed');
      // The link is a credential. Clearing the field keeps it out of the form the
      // next screenshot catches (`docs/contracts/connection-link.md`).
      setSource('');
    } else if (result.kind === 'url') {
      setValues((current) => ({
        ...current,
        name: nameEdited ? current.name : result.suggestedName,
        baseUrl: result.baseUrl,
      }));
      setLinkAccepted(false);
      setMode('discover');
    } else if (mode === 'discover') {
      // The URL the discovery fields were filled from is gone; so are they.
      setValues((current) => ({ ...current, baseUrl: '' }));
      setMode('start');
    }
  };

  const setModel = (index: number, patch: Partial<EndpointFormValues['models'][number]>) => {
    setValues((current) => ({
      ...current,
      models: current.models.map((model, at) => (at === index ? { ...model, ...patch } : model)),
    }));
  };

  const registerTyped = async () => {
    const found = validateEndpointForm(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const result = await register({ variables: { input: toRegisterInput(values) } });
    const created = result.data?.registerExternalEndpoint;
    if (!created) throw new Error('The endpoint was not returned.');
    onOpenChange(false);
    reset();
    onRegistered(created.id);
  };

  /** Registered with no models: it serves nothing, and the router attests it before anything is asked. */
  const registerForDiscovery = async () => {
    const found = validateEndpointForm({ ...values, models: [{ ...EMPTY_MODEL }] });
    const endpointOnly = Object.fromEntries(Object.entries(found).filter(([key]) => !key.startsWith('models')));
    setErrors(endpointOnly);
    if (Object.keys(endpointOnly).length > 0) return;

    const result = await register({ variables: { input: { ...toRegisterInput(values), models: [] } } });
    const created = result.data?.registerExternalEndpoint;
    if (!created) throw new Error('The endpoint was not returned.');
    setRegistered({ id: created.id, name: created.name });
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    try {
      await (mode === 'discover' ? registerForDiscovery() : registerTyped());
    } catch (caught) {
      setFailure(errorMessageOf(caught));
    }
  };

  const finish = (endpointId: string) => {
    onOpenChange(false);
    reset();
    onRegistered(endpointId);
  };

  const nameField = (
    <FormField
      id="endpoint-name"
      label="Name"
      help="Lower-case, hyphenated. Cannot be changed later — it is also the egress verifier's key for this upstream."
      error={errors.name}
    >
      <Input
        id="endpoint-name"
        value={values.name}
        onChange={(event) => {
          setNameEdited(true);
          setValues((current) => ({ ...current, name: event.target.value }));
        }}
        aria-describedby={describedBy('endpoint-name', { error: errors.name, help: true })}
        aria-invalid={Boolean(errors.name)}
        disabled={loading}
        autoComplete="off"
      />
    </FormField>
  );

  const keyField = (
    <FormField
      id="endpoint-api-key"
      label="Upstream API key"
      help="The ordinary LLM key the upstream issued you. Stored encrypted and never shown again — afterwards this screen can only show its first characters."
      error={errors.apiKey}
    >
      <Input
        id="endpoint-api-key"
        type="password"
        value={values.apiKey}
        onChange={(event) => setValues((current) => ({ ...current, apiKey: event.target.value }))}
        aria-describedby={describedBy('endpoint-api-key', { error: errors.apiKey, help: true })}
        aria-invalid={Boolean(errors.apiKey)}
        disabled={loading}
        autoComplete="off"
      />
    </FormField>
  );

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
            trust list and pins its certificate before any request is sent — nothing routes until that succeeds.
          </DialogDescription>
        </DialogHeader>

        {registered ? (
          <>
            <DiscoveryPanel endpointId={registered.id} endpointName={registered.name} onDone={finish} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => finish(registered.id)}>
                Pick models later
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <form id="register-endpoint-form" className="grid gap-5" onSubmit={(event) => void submit(event)}>
              {mode === 'typed' ? null : (
                <FormField
                  id="endpoint-source"
                  label="Endpoint URL or connection link"
                  help={SOURCE_HELP}
                  error={sourceError}
                >
                  <Input
                    id="endpoint-source"
                    value={source}
                    onChange={(event) => onSourceChange(event.target.value)}
                    onBlur={() => setSourceTouched(true)}
                    placeholder="https://model.example/v1"
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby={describedBy('endpoint-source', { error: sourceError, help: true })}
                    aria-invalid={Boolean(sourceError)}
                    disabled={loading}
                  />
                </FormField>
              )}

              {linkAccepted ? (
                <p role="status" className="text-success text-xs">
                  Filled in from the connection link. Set the prices and confirm.
                </p>
              ) : null}

              {mode === 'discover' ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {nameField}
                    <FormField id="endpoint-base-url" label="Base URL">
                      <Input id="endpoint-base-url" value={values.baseUrl} readOnly className="font-mono text-xs" />
                    </FormField>
                  </div>
                  {keyField}
                  <p className="flex gap-2 rounded-lg border bg-muted/30 p-3 text-muted-foreground text-xs">
                    <ShieldCheck className="size-4 shrink-0 text-foreground" aria-hidden="true" />
                    <span>
                      Next, this router attests the endpoint — and only once that verdict is in does it ask the upstream
                      which models it serves. Even that request goes through the attested, certificate-pinned egress.
                    </span>
                  </p>
                  <div>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto px-0"
                      onClick={() => setMode('typed')}
                      disabled={loading}
                    >
                      Enter the models by hand instead
                    </Button>
                  </div>
                </>
              ) : null}

              {mode === 'typed' ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {nameField}
                    <FormField id="endpoint-base-url" label="Base URL" error={errors.baseUrl}>
                      <Input
                        id="endpoint-base-url"
                        value={values.baseUrl}
                        onChange={(event) => setValues((current) => ({ ...current, baseUrl: event.target.value }))}
                        placeholder="https://host.example"
                        aria-describedby={describedBy('endpoint-base-url', { error: errors.baseUrl })}
                        aria-invalid={Boolean(errors.baseUrl)}
                        disabled={loading}
                        autoComplete="off"
                      />
                    </FormField>
                  </div>
                  {keyField}

                  <fieldset className="grid gap-3">
                    <legend className="mb-1 font-medium text-sm">Models and prices</legend>
                    <p className="text-muted-foreground text-xs">
                      Prices are per 1M tokens in USD and are frozen per generation, like any built-in model.
                    </p>
                    <FieldError id="endpoint-models-error" message={errors.models} />

                    {values.models.map((model, index) => (
                      // The row index is the identity here: these rows have no id until
                      // they are submitted, and reordering is not offered.
                      // biome-ignore lint/suspicious/noArrayIndexKey: see above
                      <div key={index} className="grid gap-3 rounded-lg border p-4" data-testid={`model-row-${index}`}>
                        <ModelFields
                          index={index}
                          model={model}
                          errors={errors}
                          disabled={loading}
                          onChange={(patch) => setModel(index, patch)}
                        />
                        {values.models.length > 1 ? (
                          <div>
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
                          </div>
                        ) : null}
                      </div>
                    ))}

                    <div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={loading}
                        onClick={() =>
                          setValues((current) => ({ ...current, models: [...current.models, { ...EMPTY_MODEL }] }))
                        }
                      >
                        <Plus aria-hidden="true" />
                        Add another model
                      </Button>
                    </div>
                  </fieldset>
                </>
              ) : null}

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
              {mode === 'discover' ? (
                <Button type="submit" form="register-endpoint-form" variant="brand" disabled={loading}>
                  {loading ? 'Registering…' : 'Verify and discover models'}
                </Button>
              ) : mode === 'typed' ? (
                <Button type="submit" form="register-endpoint-form" variant="brand" disabled={loading}>
                  {loading ? 'Registering…' : 'Register endpoint'}
                </Button>
              ) : null}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
