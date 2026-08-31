'use client';

import { useMutation } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import { Download } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { errorMessageOf } from '../../lib/graphql-error';
import { defaultExportRange, type ExportRangeValues, exportRangeInstants } from './export-range';
import { EXPORT_EVIDENCE } from './operations';

export interface ExportEvidenceCardProps {
  workspaceId: string | null;
}

/**
 * The auditor's bundle: everything the endpoints published for the generations
 * served in a period, as a zip.
 *
 * The mutation only mints a link — the archive is built when the link is
 * followed, and the link is signed and short-lived so it can be handed to
 * someone with no console session. It carries no verdict; whoever receives it
 * verifies it with the gatekeeper.
 */
export function ExportEvidenceCard({ workspaceId }: ExportEvidenceCardProps) {
  const [values, setValues] = React.useState<ExportRangeValues>(() => defaultExportRange());
  const [error, setError] = React.useState<string | null>(null);
  const [exportEvidence, { loading }] = useMutation(EXPORT_EVIDENCE);

  const set = (patch: Partial<ExportRangeValues>) => setValues((current) => ({ ...current, ...patch }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (workspaceId === null) return;

    const range = exportRangeInstants(values);
    if ('error' in range) {
      setError(range.error);
      return;
    }
    setError(null);

    try {
      const result = await exportEvidence({ variables: { workspaceId, ...range } });
      const url = result.data?.exportEvidence.url;
      if (!url) throw new Error('The API returned no download link.');
      startDownload(url);
    } catch (cause) {
      toast.error(errorMessageOf(cause, 'The evidence bundle could not be exported.'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export evidence bundle</CardTitle>
        <CardDescription>
          A zip of the bundles, JWS payloads and digests the endpoints published for this workspace's generations in a
          period — for an auditor. The link expires in 15 minutes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="export-from">From</Label>
            <Input
              id="export-from"
              type="date"
              value={values.from}
              onChange={(event) => set({ from: event.target.value })}
              aria-invalid={error !== null || undefined}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="export-to">To</Label>
            <Input
              id="export-to"
              type="date"
              value={values.to}
              onChange={(event) => set({ to: event.target.value })}
              aria-invalid={error !== null || undefined}
            />
          </div>
          <Button type="submit" variant="outline" disabled={loading || workspaceId === null}>
            <Download aria-hidden="true" />
            {loading ? 'Preparing…' : 'Download'}
          </Button>
          {error ? (
            <p className="w-full text-destructive text-xs" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Follows the minted link without leaving the screen.
 *
 * An anchor click rather than `window.open`: the endpoint answers with
 * `Content-Disposition: attachment`, so the browser downloads instead of
 * navigating, and a popup blocker never gets involved.
 *
 * No `download` attribute: it would override the name router-api puts in that
 * header (`evidence-<workspaceId>.zip`) with one derived from the URL, and the
 * URL ends in a signing token.
 */
function startDownload(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}
