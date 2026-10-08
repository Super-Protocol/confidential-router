'use client';

import { useLazyQuery, useMutation, useQuery } from '@apollo/client/react';
import { Badge } from '@confidential-router/ui/components/badge';
import { Button } from '@confidential-router/ui/components/button';
import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import type {
  DiscoverExternalModelsQuery,
  ExternalEndpointVerdictQuery,
  ExternalModelInput,
} from '../../generated/graphql';
import { microsToUsdInput, shortenDigest } from '../../lib/format';
import { errorMessageOf } from '../../lib/graphql-error';
import { type EndpointFormErrors, type ModelFormValues, toModelInput, validateModels } from './endpoint-form';
import { statusPresentation } from './endpoint-status';
import { FieldError, ModelFields } from './form-field';
import {
  DISCOVER_EXTERNAL_MODELS,
  EXTERNAL_ENDPOINT_VERDICT_QUERY,
  EXTERNAL_ENDPOINTS_QUERY,
  UPDATE_EXTERNAL_ENDPOINT,
} from './operations';
import { TrustFactors } from './trust-factors';

/** How often the panel re-reads the verdict while it waits; the server polls the sidecar every ~5 s. */
export const VERDICT_POLL_MS = 2_000;

/** The stages a two-factor refusal is reported at (SUP-252) — each one fixed by an approval, not a retry. */
const FACTOR_REFUSALS = new Set(['digest-not-pinned', 'measurement-not-trusted', 'digest-mismatch']);

type DiscoveredModel = DiscoverExternalModelsQuery['discoverExternalModels'][number];
type ExistingModel = NonNullable<ExternalEndpointVerdictQuery['externalEndpoint']>['models'][number];

interface PickerRow {
  selected: boolean;
  values: ModelFormValues;
  /** Already published by this endpoint: shown, never re-sent as new. */
  registeredAs: string | null;
}

export interface DiscoveryPanelProps {
  endpointId: string;
  endpointName: string;
  /** The models were registered; the caller closes and opens the drawer. */
  onDone: (endpointId: string) => void;
}

function rowOf(model: DiscoveredModel, preselect: boolean): PickerRow {
  return {
    selected: preselect && model.registeredAs === null,
    registeredAs: model.registeredAs ?? null,
    values: {
      id: model.upstreamModel,
      name: model.name ?? model.upstreamModel,
      upstreamModel: model.upstreamModel,
      contextLength: model.contextLength ? String(model.contextLength) : '',
      // A hint from an upstream that publishes its own price — another router.
      // The admin still sees and confirms it; it is this router's price now.
      promptPer1m: model.promptPer1mMicros ? microsToUsdInput(model.promptPer1mMicros) : '',
      completionPer1m: model.completionPer1mMicros ? microsToUsdInput(model.completionPer1mMicros) : '',
    },
  };
}

function existingInput(model: ExistingModel): ExternalModelInput {
  return {
    id: model.id,
    name: model.name,
    upstreamModel: model.upstreamModel ?? model.id,
    contextLength: model.contextLength,
    capabilities: model.capabilities,
    promptPer1mMicros: model.pricing.promptPer1m,
    completionPer1mMicros: model.pricing.completionPer1m,
  };
}

type StageState = 'done' | 'running' | 'failed' | 'waiting';

const STAGE_ICON: Record<StageState, React.ReactNode> = {
  done: <CheckCircle2 className="size-4 text-success" aria-hidden="true" />,
  running: <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />,
  failed: <XCircle className="size-4 text-destructive" aria-hidden="true" />,
  waiting: <Circle className="size-4 text-muted-foreground/60" aria-hidden="true" />,
};

const STAGE_STATE_LABEL: Record<StageState, string> = {
  done: 'done',
  running: 'in progress',
  failed: 'failed',
  waiting: 'waiting',
};

function Stage({ state, title, children }: { state: StageState; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3" data-state={state}>
      <span className="mt-0.5 shrink-0">{STAGE_ICON[state]}</span>
      <div className="grid min-w-0 gap-1">
        <p className="font-medium text-sm">
          {title} <span className="sr-only">— {STAGE_STATE_LABEL[state]}</span>
        </p>
        {children}
      </div>
    </li>
  );
}

/**
 * Attest, then list (SUP-249).
 *
 * The endpoint already exists, registered with no models. This panel watches the
 * router's own verdict arrive — the same chips the endpoint list uses — and only
 * once it says `VERIFIED_BY_THIS_ROUTER` asks the API to list the upstream's
 * models, which the API does through the attested egress. The order is the
 * selling point: even the listing request only reaches a verified upstream.
 */
export function DiscoveryPanel({ endpointId, endpointName, onDone }: DiscoveryPanelProps) {
  const verdict = useQuery(EXTERNAL_ENDPOINT_VERDICT_QUERY, {
    variables: { id: endpointId },
    fetchPolicy: 'network-only',
    pollInterval: VERDICT_POLL_MS,
  });
  const endpoint = verdict.data?.externalEndpoint ?? null;
  const verified = endpoint?.status === 'VERIFIED_BY_THIS_ROUTER';

  // Lazy, and asked once per panel: the call spends the upstream key, so a
  // verdict that flickers during a re-attest must not send it again. "Ask
  // again" is the admin's own way back.
  const [discover, discovery] = useLazyQuery(DISCOVER_EXTERNAL_MODELS, { fetchPolicy: 'network-only' });
  const [asked, setAsked] = React.useState(false);
  const ask = React.useCallback(() => {
    setAsked(true);
    // The result, error included, is read from `discovery`; nothing to do with the promise.
    discover({ variables: { id: endpointId } }).catch(() => undefined);
  }, [discover, endpointId]);
  React.useEffect(() => {
    if (verified && !asked) ask();
  }, [verified, asked, ask]);

  const [rows, setRows] = React.useState<PickerRow[] | null>(null);
  const [errors, setErrors] = React.useState<EndpointFormErrors>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [update, { loading: saving }] = useMutation(UPDATE_EXTERNAL_ENDPOINT, {
    refetchQueries: [{ query: EXTERNAL_ENDPOINTS_QUERY }],
    awaitRefetchQueries: true,
  });

  const discovered = discovery.data?.discoverExternalModels;
  React.useEffect(() => {
    if (!discovered) return;
    // One model is the common case — a model deployment serves one — so it
    // starts ticked; with several, picking is the admin's job. A re-ask keeps
    // whatever the admin already typed for a model that is still listed.
    setRows((current) =>
      discovered.map((model) => {
        const kept = current?.find((row) => row.values.upstreamModel === model.upstreamModel);
        return kept ? { ...kept, registeredAs: model.registeredAs ?? null } : rowOf(model, discovered.length === 1);
      }),
    );
  }, [discovered]);

  // Nothing left to wait for once the list is in, or once the endpoint is off.
  const settled = (verified && discovered !== undefined) || endpoint?.status === 'DISABLED';
  const { startPolling, stopPolling } = verdict;
  React.useEffect(() => {
    if (settled) stopPolling();
    else startPolling(VERDICT_POLL_MS);
  }, [settled, startPolling, stopPolling]);

  const setRow = (index: number, patch: Partial<PickerRow>) =>
    setRows((current) => current?.map((row, at) => (at === index ? { ...row, ...patch } : row)) ?? current);

  const submit = async () => {
    if (!rows) return;
    setFailure(null);
    const picked = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.selected && !row.registeredAs);
    if (picked.length === 0) {
      setErrors({ models: 'Tick at least one model to publish.' });
      return;
    }

    // Validated as one list, reported against each row's own position.
    const found: EndpointFormErrors = {};
    for (const [key, message] of Object.entries(validateModels(picked.map(({ row }) => row.values)))) {
      const match = /^models\.(\d+)\.(.+)$/.exec(key);
      found[match ? `models.${picked[Number(match[1])].index}.${match[2]}` : key] = message;
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    try {
      // The set as it is now, not as it was when the panel opened: the update
      // replaces it, and a model published meanwhile must not be retired by us.
      const current: readonly ExistingModel[] = (await verdict.refetch()).data?.externalEndpoint?.models ?? [];
      const taken = new Set(current.map((model) => model.id));
      const clashes = picked.filter(({ row }) => taken.has(row.values.id.trim()));
      if (clashes.length > 0) {
        setErrors(
          Object.fromEntries(
            clashes.map(({ index }) => [`models.${index}.id`, 'This endpoint already publishes that id.']),
          ),
        );
        return;
      }
      await update({
        variables: {
          id: endpointId,
          input: {
            models: [...current.map(existingInput), ...picked.map(({ row }) => toModelInput(row.values))],
          },
        },
      });
      onDone(endpointId);
    } catch (caught) {
      setFailure(errorMessageOf(caught));
    }
  };

  const status = endpoint?.status ?? 'PENDING';
  const presentation = statusPresentation(status);
  // Refused by a trust factor rather than by the pipeline: the approvals above
  // are the fix, so the generic "add it to the trust list" pointer is not shown.
  const factorRefusal = FACTOR_REFUSALS.has(endpoint?.lastStage ?? '');
  const awaitingApproval = status === 'PENDING' && endpoint?.lastStage === 'digest-not-pinned';
  const attestState: StageState =
    status === 'VERIFIED_BY_THIS_ROUTER' ? 'done' : status === 'DENIED_BY_THIS_ROUTER' ? 'failed' : 'running';
  const listState: StageState = !verified ? 'waiting' : discovery.error ? 'failed' : discovered ? 'done' : 'running';

  return (
    <section aria-label={`Discover models on ${endpointName}`} className="grid gap-4">
      <ol aria-label="Verification stages" className="grid gap-3 rounded-lg border bg-muted/30 p-4">
        <Stage state="done" title="Registered">
          <p className="text-muted-foreground text-xs">The key is sealed. Nothing routes, and nothing is asked yet.</p>
        </Stage>
        <Stage state={status === 'DISABLED' ? 'failed' : attestState} title="Attested by this router">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={presentation.variant}>{presentation.label}</Badge>
            {endpoint?.measurementSeen ? (
              <span className="font-mono text-muted-foreground text-xs" title={endpoint.measurementSeen}>
                measurement {shortenDigest(endpoint.measurementSeen, 6)}
              </span>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs">
            {awaitingApproval
              ? 'Evidence verified. Approve the cloud and this deployment below — one click each — and the router re-checks at once.'
              : status === 'PENDING'
                ? 'Fetching its evidence, checking the cloud measurement and the deployment digest, and pinning its certificate.'
                : presentation.detail}
          </p>
          {/*
           * Two-factor trust (SUP-252): a fresh endpoint is never admitted until an
           * admin approves what the first check saw, so the approval lives in the
           * stage that waits for it.
           */}
          {endpoint &&
          !verified &&
          status !== 'DISABLED' &&
          (endpoint.measurementSeen || endpoint.evidenceDigestSeen) ? (
            <TrustFactors endpoint={{ ...endpoint, name: endpointName }} isAdmin />
          ) : null}
          {status === 'DENIED_BY_THIS_ROUTER' && !factorRefusal ? (
            <p role="alert" className="text-destructive text-xs">
              {endpoint?.lastStage ? `${endpoint.lastStage}: ` : ''}
              {endpoint?.lastReason ?? 'refused'}. If this cloud should be trusted, add its measurement on the{' '}
              <Link href="/admin/trust" className="underline underline-offset-2">
                trust list
              </Link>{' '}
              — the next check picks it up, and this panel keeps watching.
            </p>
          ) : null}
        </Stage>
        <Stage state={listState} title="Models listed through the attested egress">
          <div className="flex flex-wrap items-center gap-2">
            {discovery.error ? (
              <p role="alert" className="text-destructive text-xs">
                {errorMessageOf(discovery.error)}
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                {verified
                  ? discovered && !discovery.loading
                    ? `${discovered.length} model${discovered.length === 1 ? '' : 's'} found.`
                    : 'Asking the upstream for GET /v1/models…'
                  : 'Starts once the verdict is in — not one request goes upstream before it.'}
              </p>
            )}
            {/* Only while verified: the API refuses to ask an upstream that is not. */}
            {verified && (discovery.error || discovered) ? (
              <Button type="button" variant="outline" size="sm" onClick={ask} disabled={discovery.loading || saving}>
                Ask again
              </Button>
            ) : null}
          </div>
        </Stage>
      </ol>

      {rows ? (
        <fieldset className="grid gap-3">
          <legend className="mb-1 font-medium text-sm">Models to publish</legend>
          <p className="text-muted-foreground text-xs">
            Prices are per 1M tokens in USD and are frozen per generation, like any built-in model. A price the upstream
            publishes is filled in as a starting point — what this router charges is yours to set.
          </p>
          {rows.length === 0 ? <p className="text-muted-foreground text-sm">The upstream lists no models.</p> : null}
          {rows.map((row, index) => (
            <div key={row.values.upstreamModel} className="grid gap-3 rounded-lg border p-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={row.selected || row.registeredAs !== null}
                  disabled={row.registeredAs !== null || saving}
                  onChange={(event) => setRow(index, { selected: event.target.checked })}
                />
                <span className="font-mono">{row.values.upstreamModel}</span>
                {row.registeredAs ? (
                  <span className="text-muted-foreground text-xs">already published as {row.registeredAs}</span>
                ) : null}
              </label>
              {row.selected && !row.registeredAs ? (
                <ModelFields
                  index={index}
                  model={row.values}
                  errors={errors}
                  disabled={saving}
                  editableUpstream={false}
                  onChange={(patch) => setRow(index, { values: { ...row.values, ...patch } })}
                />
              ) : null}
            </div>
          ))}
          <FieldError id="discovered-models-error" message={errors.models} />
          {failure ? (
            <p role="alert" className="text-destructive text-sm">
              {failure}
            </p>
          ) : null}
          <div>
            <Button type="button" variant="brand" disabled={saving || rows.length === 0} onClick={() => void submit()}>
              {saving ? 'Publishing…' : 'Publish selected models'}
            </Button>
          </div>
        </fieldset>
      ) : null}
    </section>
  );
}
