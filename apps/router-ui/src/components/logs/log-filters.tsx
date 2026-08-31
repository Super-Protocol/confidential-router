'use client';

import { Button } from '@confidential-router/ui/components/button';
import { Label } from '@confidential-router/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@confidential-router/ui/components/select';
import { ArrowDownWideNarrow, ArrowUpNarrowWide } from 'lucide-react';
import * as React from 'react';
import type { GenerationSortField, GenerationStatus } from '../../generated/graphql';
import { RangePicker } from '../activity/range-picker';
import { ANY, type LogFilterState, SORT_FIELD_LABELS, STATUS_LABELS } from './filters';

export interface FilterOption {
  id: string;
  label: string;
}

export interface LogFiltersProps {
  value: LogFilterState;
  onChange: (value: LogFilterState) => void;
  models: FilterOption[];
  apiKeys: FilterOption[];
  /** Rendered at the end of the row — the CSV link. */
  action?: React.ReactNode;
}

const SORT_FIELDS: GenerationSortField[] = ['CREATED_AT', 'COST', 'LATENCY', 'TOTAL_TOKENS'];
const STATUSES: GenerationStatus[] = ['OK', 'ERROR', 'ABORTED'];

/**
 * `id` is the control the caption labels. It is omitted for the range toggle,
 * which is a group of buttons and carries its own `aria-label` — a `<label for>`
 * pointing at nothing is worse than no label at all.
 */
function Field({ id, label, children }: { id?: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {id ? (
        <Label htmlFor={id} className="text-muted-foreground text-xs">
          {label}
        </Label>
      ) : (
        <span aria-hidden="true" className="text-muted-foreground text-xs leading-none">
          {label}
        </span>
      )}
      {children}
    </div>
  );
}

/** Range, model, key, status and sort — every input to the `generations` query. */
export function LogFilters({ value, onChange, models, apiKeys, action }: LogFiltersProps) {
  const patch = React.useCallback(
    (next: Partial<LogFilterState>) => onChange({ ...value, ...next }),
    [onChange, value],
  );

  const ascending = value.sortDirection === 'ASC';

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <Field label="Range">
        <RangePicker value={value.range} label="Time range" onChange={(range) => patch({ range })} />
      </Field>

      <Field id="log-model" label="Model">
        <Select value={value.modelId} onValueChange={(modelId) => patch({ modelId })}>
          <SelectTrigger id="log-model" size="sm" className="w-[13rem]">
            <SelectValue placeholder="All models" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All models</SelectItem>
            {models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field id="log-key" label="API key">
        <Select value={value.apiKeyId} onValueChange={(apiKeyId) => patch({ apiKeyId })}>
          <SelectTrigger id="log-key" size="sm" className="w-[11rem]">
            <SelectValue placeholder="All keys" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All keys</SelectItem>
            {apiKeys.map((key) => (
              <SelectItem key={key.id} value={key.id}>
                {key.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field id="log-status" label="Status">
        <Select value={value.status} onValueChange={(status) => patch({ status: status as LogFilterState['status'] })}>
          <SelectTrigger id="log-status" size="sm" className="w-[8.5rem]">
            <SelectValue placeholder="Any status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any status</SelectItem>
            {STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field id="log-sort" label="Sort by">
        <div className="flex items-center gap-1.5">
          <Select
            value={value.sortField}
            onValueChange={(sortField) => patch({ sortField: sortField as GenerationSortField })}
          >
            <SelectTrigger id="log-sort" size="sm" className="w-[8.5rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_FIELDS.map((field) => (
                <SelectItem key={field} value={field}>
                  {SORT_FIELD_LABELS[field]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-8"
            aria-pressed={ascending}
            aria-label={ascending ? 'Sort ascending' : 'Sort descending'}
            onClick={() => patch({ sortDirection: ascending ? 'DESC' : 'ASC' })}
          >
            {ascending ? (
              <ArrowUpNarrowWide className="size-4" aria-hidden="true" />
            ) : (
              <ArrowDownWideNarrow className="size-4" aria-hidden="true" />
            )}
          </Button>
        </div>
      </Field>

      {action ? <div className="ml-auto">{action}</div> : null}
    </div>
  );
}
