import type { GenerationStatus } from '../generated/graphql';
import { publicConfig } from './public-config';

export interface GenerationCsvParams {
  workspaceId: string;
  /** Inclusive start, ISO-8601. */
  from?: string | null;
  /** Exclusive end, ISO-8601. */
  to?: string | null;
  modelIds?: string[];
  apiKeyIds?: string[];
  statuses?: GenerationStatus[];
}

/**
 * The export is REST, not GraphQL, because a download is a browser navigation
 * with a filename and a content type (`docs/contracts/console-graphql.md`). The
 * link carries no token: the endpoint authorises on the same session cookie the
 * console already sends, and re-checks workspace membership.
 *
 * `status` is lower-case here and upper-case in GraphQL — the REST DTO validates
 * against the stored enum (`ok` / `error` / `aborted`), the schema against the
 * SDL enum. Sending the wrong casing is a 400, so the mapping lives in one place.
 */
export function generationsCsvUrl(params: GenerationCsvParams): string {
  const url = new URL('/activity/generations.csv', publicConfig().apiOrigin);
  url.searchParams.set('workspaceId', params.workspaceId);

  if (params.from) url.searchParams.set('from', params.from);
  if (params.to) url.searchParams.set('to', params.to);
  if (params.modelIds?.length) url.searchParams.set('modelIds', params.modelIds.join(','));
  if (params.apiKeyIds?.length) url.searchParams.set('apiKeyIds', params.apiKeyIds.join(','));
  if (params.statuses?.length) {
    url.searchParams.set('status', params.statuses.map((status) => status.toLowerCase()).join(','));
  }

  return url.toString();
}
