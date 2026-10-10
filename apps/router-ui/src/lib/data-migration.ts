import { publicConfig } from './public-config';

/**
 * The deployment export and its import (SUP-271), over REST: both ends are a
 * file, and GraphQL carries neither a download nor an upload. The endpoints
 * authorise on the session cookie the console already sends, and on
 * `auth.adminEmails` — there is no link to hand on, by design.
 */

const CONTENT_TYPE = 'application/gzip';

export type ImportSectionName =
  | 'users'
  | 'workspaces'
  | 'workspaceMembers'
  | 'creditLedger'
  | 'inviteCodes'
  | 'inviteRedemptions'
  | 'externalEndpoints'
  | 'externalModels'
  | 'trustedMeasurements';

export interface ImportSection {
  section: ImportSectionName;
  inBundle: number;
  toCreate: number;
  alreadyPresent: number;
  conflicts: string[];
}

export interface ImportReport {
  applied: boolean;
  ok: boolean;
  schemaVersion: number;
  exportedAt: string;
  source: { publicBaseUrl: string; routerVersion: string; evidenceDigest: string | null };
  contentSha256: string;
  counts: Record<string, number>;
  totalBalanceMicros: string;
  refusals: string[];
  sections: ImportSection[];
  notes: string[];
}

export interface DownloadedExport {
  blob: Blob;
  fileName: string;
  contentSha256: string | null;
}

/** A refusal the API explained; `message` is written for the operator. */
export class DataMigrationError extends Error {
  override readonly name = 'DataMigrationError';
}

async function failure(response: Response, fallback: string): Promise<DataMigrationError> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message) {
      return new DataMigrationError(body.message);
    }
  } catch {
    // Not JSON: the fallback says what was being attempted.
  }
  return new DataMigrationError(`${fallback} (HTTP ${response.status}).`);
}

export async function downloadExport(): Promise<DownloadedExport> {
  const response = await fetch(`${publicConfig().apiOrigin}/admin/data/export`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw await failure(response, 'The export could not be generated');
  }
  const named = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '');
  return {
    blob: await response.blob(),
    fileName: named?.[1] ?? 'router-export.json.gz',
    contentSha256: response.headers.get('X-Export-Sha256'),
  };
}

async function upload(file: Blob, query: string): Promise<ImportReport> {
  const response = await fetch(`${publicConfig().apiOrigin}/admin/data/import${query}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': CONTENT_TYPE },
    body: file,
  });
  if (!response.ok) {
    throw await failure(response, 'The file could not be read');
  }
  return (await response.json()) as ImportReport;
}

/** What importing `file` would do. Nothing is written. */
export function dryRunImport(file: Blob): Promise<ImportReport> {
  return upload(file, '');
}

/** Imports `file`, which has to be the one the dry run reported `contentSha256` for. */
export function applyImport(file: Blob, contentSha256: string): Promise<ImportReport> {
  return upload(file, `?apply=true&expect=${encodeURIComponent(contentSha256)}`);
}

/** Hands a blob to the browser as a download, and lets go of it. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
