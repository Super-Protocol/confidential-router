'use client';

import { useQuery } from '@apollo/client/react';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import { Input } from '@confidential-router/ui/components/input';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@confidential-router/ui/components/table';
import { Tabs, TabsList, TabsTrigger } from '@confidential-router/ui/components/tabs';
import { PackageSearch, Search } from 'lucide-react';
import * as React from 'react';
import { graphql } from '../../generated';
import type { ModelCatalogueQuery } from '../../generated/graphql';
import { formatContextLength, formatPricePer1m } from '../../lib/format';
import { EvidenceBadge } from '../evidence/evidence-badge';
import { ExternalAttestationBadge } from '../external/external-attestation-badge';
import { EXTERNAL_AVAILABILITY } from '../external/external-vocabulary';

const ALL_TEES = 'all';

/**
 * The catalogue is public — `models` needs no session, which is what lets a
 * signed-out visitor see what the router serves and at what price.
 *
 * `endpoint` and `externalUpstream` are both asked for and exactly one comes
 * back per row: the API populates the first for a model in this deployment and
 * the second for one in another (ADR-008 §1). `externalUpstream` is null for a
 * signed-out visitor too (SUP-221 ruling 3) — they get the model, the price and
 * `available`, and no verdict detail — so the external column has three cases to
 * render and not two.
 */
export const MODEL_CATALOGUE_QUERY = graphql(`
  query ModelCatalogue {
    models {
      id
      slug
      name
      contextLength
      tee
      origin
      available
      pricing {
        promptPer1m
        completionPer1m
      }
      endpoint {
        ...EndpointEvidenceFields
      }
      externalUpstream {
        ...ExternalUpstreamFields
      }
    }
  }
`);

type CatalogueModel = ModelCatalogueQuery['models'][number];

/**
 * Name, slug and TEE label, so one box covers "what the prototype filtered on" —
 * plus the upstream's hostname, which is the only name an external row has in
 * place of a TEE label and is what a reader looking for one would type.
 */
export function matchesQuery(model: CatalogueModel, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [model.name, model.slug, model.tee, model.externalUpstream?.hostname].some((field) =>
    field?.toLowerCase().includes(needle),
  );
}

export function ModelsScreen() {
  const { data, loading, error, refetch } = useQuery(MODEL_CATALOGUE_QUERY, { fetchPolicy: 'cache-and-network' });
  const [query, setQuery] = React.useState('');
  const [tee, setTee] = React.useState(ALL_TEES);

  const models = data?.models;

  // In config order, so the filter chips do not reshuffle as the catalogue grows.
  // External models declare no TEE label and therefore contribute no chip — and
  // selecting one hides them, which is the filter being honest rather than
  // losing rows: it narrows on an operator's declaration about this deployment's
  // own hardware, and there is none to make about someone else's.
  const tees = React.useMemo(
    () => [...new Set((models ?? []).flatMap((model) => (model.tee ? [model.tee] : [])))],
    [models],
  );

  const visible = React.useMemo(
    () => (models ?? []).filter((model) => (tee === ALL_TEES || model.tee === tee) && matchesQuery(model, query)),
    [models, tee, query],
  );

  if (error && !models) {
    return (
      <ErrorState
        description="The model catalogue could not be loaded."
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  if (!models) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-full max-w-md" aria-hidden="true" />
        <Skeleton className="h-72" aria-hidden="true" />
        <span className="sr-only" role="status" aria-busy={loading}>
          Loading the model catalogue
        </span>
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <EmptyState
        icon={<PackageSearch className="size-5" aria-hidden="true" />}
        title="No models are served yet"
        description="The router config declares no models. They appear here as soon as one is configured."
      />
    );
  }

  const endpointCount = new Set(models.flatMap((model) => (model.endpoint ? [model.endpoint.id] : []))).size;
  const externalCount = models.filter((model) => model.origin === 'EXTERNAL').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-56 flex-1">
          <Search
            className="-translate-y-1/2 absolute top-1/2 left-3 size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter models"
            placeholder="Filter by name, family or TEE…"
            className="pl-8"
          />
        </div>

        {tees.length > 1 ? (
          <Tabs value={tee} onValueChange={setTee}>
            <TabsList aria-label="Filter by TEE">
              <TabsTrigger value={ALL_TEES}>All TEEs</TabsTrigger>
              {tees.map((label) => (
                <TabsTrigger key={label} value={label}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<PackageSearch className="size-5" aria-hidden="true" />}
          title="No model matches this filter"
          description="Try a shorter search term, or clear the TEE filter."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table aria-label="Model catalogue">
            <TableHeader>
              <TableRow>
                <TableHead className="px-4">Model</TableHead>
                <TableHead>Endpoint</TableHead>
                <TableHead>TEE</TableHead>
                <TableHead className="text-right">Context</TableHead>
                <TableHead className="text-right">Input /1M</TableHead>
                <TableHead className="text-right">Output /1M</TableHead>
                {/*
                  Evidence belongs to the endpoint, not the model: the models are
                  LiteLLM-backed inside the attested cluster and are never
                  attested one by one (ADR-002, decision 9). The same holds one
                  deployment out: an external model's attestation is its
                  upstream's, which is why the header names neither kind — the
                  cell does, in that kind's own words.
                */}
                <TableHead className="px-4">Attestation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((model) => (
                <TableRow key={model.id}>
                  <TableCell className="px-4">
                    <span className="block font-medium text-sm">{model.name}</span>
                    <span className="block font-mono text-muted-foreground text-xs">{model.slug}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {model.endpoint?.hostname ?? model.externalUpstream?.hostname ?? (
                      // Signed out, on an external row: ruling 3 keeps endpoint
                      // URLs off the anonymous catalogue, and an em dash is the
                      // honest rendering of "withheld" rather than a blank cell.
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{model.tee ?? '—'}</TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatContextLength(model.contextLength)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatPricePer1m(model.pricing.promptPer1m)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatPricePer1m(model.pricing.completionPer1m)}
                  </TableCell>
                  <TableCell className="px-4">
                    <AttestationCell
                      model={model}
                      onRefreshed={() => {
                        void refetch();
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        {visible.length === models.length
          ? servedFrom(models.length - externalCount, endpointCount, externalCount)
          : `${visible.length} of ${models.length} models.`}{' '}
        Prices are in USD per 1M tokens and are billed from credits.
      </p>
    </div>
  );
}

/**
 * The count line, counting the two origins apart.
 *
 * Apart because they are served from different places and a single total would
 * imply one: "12 models from 2 endpoints" is false the moment three of them run
 * in somebody else's cluster. Each clause is dropped when its count is zero, so a
 * deployment with only built-ins reads exactly as it did before ADR-008 and one
 * with only external capacity does not claim endpoints it has none of.
 */
function servedFrom(own: number, endpoints: number, external: number): string {
  const clauses: string[] = [];
  if (own > 0 || external === 0) {
    clauses.push(`${plural(own, 'model')} served from ${plural(endpoints, 'endpoint')}`);
  }
  if (external > 0) {
    clauses.push(
      clauses.length > 0
        ? `${external} from external endpoints`
        : `${plural(external, 'model')} served from external endpoints`,
    );
  }
  return `${clauses.join(', and ')}.`;
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * The attestation cell, and the one place the row's origin decides which
 * vocabulary applies.
 *
 * Three branches, because there are three different statements to make and none
 * of them is a weaker version of another: what *this deployment's platform
 * publishes* for one of our endpoints, what *this router has verified* about an
 * upstream, and — for a reader with no session — nothing but whether the model
 * can be used right now. The two badges come from two modules and share no
 * label (`external-vocabulary.ts`, `evidence/evidence-state.ts`).
 */
function AttestationCell({ model, onRefreshed }: { model: CatalogueModel; onRefreshed: () => void }) {
  if (model.endpoint) {
    return <EvidenceBadge endpoint={model.endpoint} onRefreshed={onRefreshed} />;
  }
  if (model.externalUpstream) {
    return <ExternalAttestationBadge upstream={model.externalUpstream} />;
  }
  return (
    <span className="text-muted-foreground text-xs">
      {model.available ? EXTERNAL_AVAILABILITY.available : EXTERNAL_AVAILABILITY.unavailable}
    </span>
  );
}
