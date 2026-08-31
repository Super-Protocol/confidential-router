import type {
  GenerationFilter,
  GenerationSort,
  GenerationSortField,
  GenerationStatus,
  SortDirection,
} from '../../generated/graphql';
import { type RangeKey, resolveRange } from '../../lib/ranges';

/**
 * Radix's `Select` reserves the empty string for "no value chosen", so "no
 * filter" needs a sentinel of its own rather than `''`.
 */
export const ANY = 'any';

export interface LogFilterState {
  range: RangeKey;
  /** A model id, or `ANY`. */
  modelId: string;
  /** An API key id, or `ANY`. */
  apiKeyId: string;
  status: GenerationStatus | typeof ANY;
  sortField: GenerationSortField;
  sortDirection: SortDirection;
}

export const DEFAULT_FILTERS: LogFilterState = {
  range: '24h',
  modelId: ANY,
  apiKeyId: ANY,
  status: ANY,
  sortField: 'CREATED_AT',
  sortDirection: 'DESC',
};

export const SORT_FIELD_LABELS: Record<GenerationSortField, string> = {
  CREATED_AT: 'Time',
  COST: 'Cost',
  LATENCY: 'Latency',
  TOTAL_TOKENS: 'Tokens',
};

export const STATUS_LABELS: Record<GenerationStatus, string> = {
  OK: 'OK',
  ERROR: 'Error',
  ABORTED: 'Aborted',
};

export interface ResolvedFilters {
  filter: GenerationFilter;
  sort: GenerationSort;
  /** The same window, for the CSV link, which takes flat query parameters. */
  window: { from: string; to: string; modelIds?: string[]; apiKeyIds?: string[]; statuses?: GenerationStatus[] };
}

/**
 * Turns the screen's control state into the query's `filter`/`sort` inputs.
 *
 * `ANY` becomes an omitted field rather than an empty list: the API reads an
 * empty `modelIds` as "match no model", which would render an always-empty log
 * for a filter the viewer thinks is off.
 */
export function resolveFilters(state: LogFilterState, now: Date): ResolvedFilters {
  const { from, to } = resolveRange(state.range, now);
  const modelIds = state.modelId === ANY ? undefined : [state.modelId];
  const apiKeyIds = state.apiKeyId === ANY ? undefined : [state.apiKeyId];
  const statuses = state.status === ANY ? undefined : [state.status];

  return {
    filter: { from, to, modelIds, apiKeyIds, statuses },
    sort: { field: state.sortField, direction: state.sortDirection },
    window: { from, to, modelIds, apiKeyIds, statuses },
  };
}
