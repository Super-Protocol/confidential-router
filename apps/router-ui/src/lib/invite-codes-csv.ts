import type { InviteCodeStatus } from '../generated/graphql';
import { publicConfig } from './public-config';

/*
 * The invitation codes CSV (SUP-272): the Codes tab as a file, out of one
 * deployment and into the next. REST rather than GraphQL because both ends are a
 * file; authorised by the session cookie and `auth.adminEmails` on the API.
 */

/** `router-api`'s `InviteCodesImportReport`. */
export interface InviteCodesImportReport {
  sha256: string;
  applied: boolean;
  ok: boolean;
  totalRows: number;
  toCreate: Record<Lowercase<InviteCodeStatus>, number>;
  createCount: number;
  campaigns: number;
  redemptionsLinked: number;
  redemptionsUnlinked: number;
  duplicateCount: number;
  duplicates: { row: number; code: string; reason: 'already_present' | 'repeated_in_file' }[];
  errorCount: number;
  errors: { row: number; message: string }[];
}

export interface InviteCodesCsvFilter {
  campaign?: string | null;
  status?: InviteCodeStatus | null;
}

/**
 * The export's link. A plain navigation, like the Logs export: the browser saves
 * the file under the name the API gives it. `status` is lower-case here and
 * upper-case in GraphQL, as on `generationsCsvUrl`.
 */
export function inviteCodesCsvUrl({ campaign, status }: InviteCodesCsvFilter = {}): string {
  const url = new URL('/admin/invite-codes/export.csv', publicConfig().apiOrigin);
  if (campaign) url.searchParams.set('campaign', campaign);
  if (status) url.searchParams.set('status', status.toLowerCase());
  return url.toString();
}

/**
 * Sends the file for a dry run, or — with the hash that dry run reported — to be
 * imported. Throws with the API's own sentence when the file is refused outright.
 */
export async function importInviteCodesCsv(csv: string, apply?: { expect: string }): Promise<InviteCodesImportReport> {
  const url = new URL('/admin/invite-codes/import', publicConfig().apiOrigin);
  if (apply) {
    url.searchParams.set('apply', 'true');
    url.searchParams.set('expect', apply.expect);
  }
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'text/csv' },
    body: csv,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
    throw new Error(
      typeof body?.message === 'string' ? body.message : `The import could not be read (HTTP ${response.status}).`,
    );
  }
  return (await response.json()) as InviteCodesImportReport;
}
