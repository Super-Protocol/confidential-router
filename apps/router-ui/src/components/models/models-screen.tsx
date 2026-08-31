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

const ALL_TEES = 'all';

/**
 * The catalogue is public — `models` needs no session, which is what lets a
 * signed-out visitor see what the router serves and at what price.
 */
export const MODEL_CATALOGUE_QUERY = graphql(`
  query ModelCatalogue {
    models {
      id
      slug
      name
      contextLength
      tee
      pricing {
        promptPer1m
        completionPer1m
      }
      endpoint {
        ...EndpointEvidenceFields
      }
    }
  }
`);

type CatalogueModel = ModelCatalogueQuery['models'][number];

/** Name, slug and TEE label, so one box covers "what the prototype filtered on". */
export function matchesQuery(model: CatalogueModel, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [model.name, model.slug, model.tee].some((field) => field.toLowerCase().includes(needle));
}

export function ModelsScreen() {
  const { data, loading, error, refetch } = useQuery(MODEL_CATALOGUE_QUERY, { fetchPolicy: 'cache-and-network' });
  const [query, setQuery] = React.useState('');
  const [tee, setTee] = React.useState(ALL_TEES);

  const models = data?.models;

  // In config order, so the filter chips do not reshuffle as the catalogue grows.
  const tees = React.useMemo(() => [...new Set(models?.map((model) => model.tee) ?? [])], [models]);

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

  const endpointCount = new Set(models.map((model) => model.endpoint.id)).size;

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
                  attested one by one (ADR-002, decision 9).
                */}
                <TableHead className="px-4">Endpoint evidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((model) => (
                <TableRow key={model.id}>
                  <TableCell className="px-4">
                    <span className="font-medium text-sm">{model.name}</span>
                    <span className="block font-mono text-muted-foreground text-xs">{model.slug}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{model.endpoint.hostname}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{model.tee}</TableCell>
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
                    <EvidenceBadge
                      endpoint={model.endpoint}
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
          ? `${models.length} models served from ${endpointCount} ${endpointCount === 1 ? 'endpoint' : 'endpoints'}.`
          : `${visible.length} of ${models.length} models.`}{' '}
        Prices are in USD per 1M tokens and are billed from credits.
      </p>
    </div>
  );
}
