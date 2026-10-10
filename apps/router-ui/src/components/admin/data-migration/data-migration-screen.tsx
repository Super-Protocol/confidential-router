'use client';

import { Badge } from '@confidential-router/ui/components/badge';
import { Button } from '@confidential-router/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@confidential-router/ui/components/card';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@confidential-router/ui/components/table';
import { CircleAlert, CircleCheck, Download, FileSearch, Lock, Upload } from 'lucide-react';
import * as React from 'react';
import {
  applyImport,
  DataMigrationError,
  downloadExport,
  dryRunImport,
  type ImportReport,
  type ImportSectionName,
  saveBlob,
} from '../../../lib/data-migration';
import { formatTimestamp, formatUsd } from '../../../lib/format';
import { PageHeader } from '../../page-header';
import { useViewerAdminState } from '../../session/use-viewer-is-admin';

const TITLE = 'Export & import';
const DESCRIPTION =
  'Carry this deployment’s accounts, credit and invitation codes across a redeploy: export here, import into the fresh deployment.';

const SECTION_LABELS: Record<ImportSectionName, string> = {
  users: 'Accounts',
  workspaces: 'Workspaces',
  workspaceMembers: 'Workspace memberships',
  creditLedger: 'Credit ledger entries',
  inviteCodes: 'Invitation codes',
  inviteRedemptions: 'Invitation redemptions',
  externalEndpoints: 'External endpoints',
  externalModels: 'External models',
  trustedMeasurements: 'Trusted measurements',
};

function messageOf(error: unknown, fallback: string): string {
  return error instanceof DataMigrationError ? error.message : fallback;
}

/**
 * The redeploy migration path (SUP-271): one button that writes the deployment
 * export, and an import that shows what it would do before it does it.
 *
 * Administrators only, like Invitations and for the same reason — the file is
 * other people's addresses and live invitation codes. A member who finds the URL
 * is told so and the screen asks the API nothing; the API refuses them anyway.
 */
export function DataMigrationScreen() {
  const { isAdmin, resolved } = useViewerAdminState();

  if (!resolved) {
    return (
      <>
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <Skeleton className="h-64 w-full" data-testid="data-migration-gate-loading" />
      </>
    );
  }

  if (!isAdmin) {
    return (
      <>
        <PageHeader title={TITLE} />
        <EmptyState
          icon={<Lock className="size-5" aria-hidden="true" />}
          title="Administrators only"
          description="Exporting and importing a deployment’s data is restricted to its administrators."
          data-testid="data-migration-restricted"
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title={TITLE} description={DESCRIPTION} />
      <div className="grid gap-6">
        <ExportCard />
        <ImportCard />
      </div>
    </>
  );
}

function ExportCard() {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<{ fileName: string; contentSha256: string | null } | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const exported = await downloadExport();
      saveBlob(exported.blob, exported.fileName);
      setDone({ fileName: exported.fileName, contentSha256: exported.contentSha256 });
    } catch (caught) {
      setError(messageOf(caught, 'The export could not be generated. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="export-card">
      <CardHeader>
        <CardTitle>Export this deployment</CardTitle>
        <CardDescription>
          One file, generated when you ask for it and not kept on the server. Take it immediately before you replace the
          deployment — anything that happens here afterwards is not in it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <p className="mb-1 font-medium">In the file</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>Accounts: address, name, sign-up date and which invitation each came from</li>
              <li>Workspaces, their credit balances and the full credit ledger</li>
              <li>Every invitation code, including the ones nobody has redeemed yet</li>
              <li>External endpoints and the trust list</li>
            </ul>
          </div>
          <div>
            <p className="mb-1 font-medium">Left behind</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>Chats, generation logs and activity history</li>
              <li>
                API keys — they are stored hashed and cannot be moved, so everyone issues new keys after a migration
              </li>
              <li>Upstream API keys of external endpoints — enter them again after importing</li>
              <li>Sessions and every sign-in credential: people sign in again on the new deployment</li>
            </ul>
          </div>
        </div>
        <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <span>
            The file holds no secrets, but it does hold personal data and invitation codes that can still be redeemed.
            Keep it private and delete it once the new deployment is verified.
          </span>
        </p>
        {error ? (
          <p role="alert" className="text-destructive" data-testid="export-error">
            {error}
          </p>
        ) : null}
        {done ? (
          <div className="rounded-md border p-3" data-testid="export-done">
            <p>
              Saved <span className="font-medium">{done.fileName}</span>.
            </p>
            {done.contentSha256 ? (
              <p className="mt-1 text-muted-foreground">
                SHA-256 of its contents — the import screen shows the same value for an unaltered file:
                <code className="mt-1 block break-all font-mono text-xs text-foreground" data-testid="export-sha">
                  {done.contentSha256}
                </code>
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
      <CardFooter>
        <Button variant="brand" onClick={() => void run()} disabled={busy} data-testid="export-button">
          <Download aria-hidden="true" />
          {busy ? 'Generating…' : 'Download export'}
        </Button>
      </CardFooter>
    </Card>
  );
}

function ImportCard() {
  const [file, setFile] = React.useState<File | null>(null);
  const [report, setReport] = React.useState<ImportReport | null>(null);
  const [busy, setBusy] = React.useState<'check' | 'import' | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  function choose(next: File | null) {
    setFile(next);
    // A report describes one file; a different file has not been looked at yet.
    setReport(null);
    setError(null);
  }

  async function run(kind: 'check' | 'import') {
    if (!file) return;
    setBusy(kind);
    setError(null);
    try {
      setReport(kind === 'import' && report ? await applyImport(file, report.contentSha256) : await dryRunImport(file));
    } catch (caught) {
      setError(messageOf(caught, 'The file could not be sent. Try again.'));
    } finally {
      setBusy(null);
    }
  }

  const canImport = !!file && !!report && report.ok && !report.applied;

  return (
    <Card data-testid="import-card">
      <CardHeader>
        <CardTitle>Import into this deployment</CardTitle>
        <CardDescription>
          Only into a fresh deployment — one where nobody but its administrators has signed in yet. Check the file
          first: the check shows what would be created and writes nothing.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <label className="grid gap-1.5">
          <span className="font-medium">Export file</span>
          <input
            type="file"
            accept=".gz,application/gzip"
            className="block w-full max-w-md cursor-pointer rounded-md border bg-background text-sm file:mr-3 file:cursor-pointer file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-secondary-foreground"
            onChange={(event) => choose(event.target.files?.[0] ?? null)}
            data-testid="import-file"
          />
        </label>
        {error ? (
          <p role="alert" className="flex items-start gap-2 text-destructive" data-testid="import-error">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        ) : null}
        {report ? <ImportReportView report={report} /> : null}
      </CardContent>
      <CardFooter className="gap-3">
        <Button
          variant="outline"
          onClick={() => void run('check')}
          disabled={!file || busy !== null}
          data-testid="import-check"
        >
          <FileSearch aria-hidden="true" />
          {busy === 'check' ? 'Checking…' : 'Check file'}
        </Button>
        <Button
          variant="brand"
          onClick={() => void run('import')}
          disabled={!canImport || busy !== null}
          data-testid="import-apply"
        >
          <Upload aria-hidden="true" />
          {busy === 'import' ? 'Importing…' : 'Import'}
        </Button>
      </CardFooter>
    </Card>
  );
}

function ImportReportView({ report }: { report: ImportReport }) {
  const conflicts = report.sections.flatMap((section) => section.conflicts);

  return (
    <div className="grid gap-4" data-testid="import-report">
      <div className="flex flex-wrap items-center gap-2">
        {report.applied ? (
          <Badge variant="success" data-testid="import-verdict">
            <CircleCheck aria-hidden="true" /> Imported
          </Badge>
        ) : report.ok ? (
          <Badge variant="brand" data-testid="import-verdict">
            Ready to import — nothing written yet
          </Badge>
        ) : (
          <Badge variant="destructive" data-testid="import-verdict">
            Cannot be imported — nothing written
          </Badge>
        )}
      </div>

      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">Exported from</dt>
        <dd className="break-all">{report.source.publicBaseUrl}</dd>
        <dt className="text-muted-foreground">Exported at</dt>
        <dd>{formatTimestamp(report.exportedAt)}</dd>
        <dt className="text-muted-foreground">Router version</dt>
        <dd>{report.source.routerVersion}</dd>
        <dt className="text-muted-foreground">Evidence digest of the source</dt>
        <dd className="break-all font-mono text-xs">{report.source.evidenceDigest ?? 'none published'}</dd>
        <dt className="text-muted-foreground">Contents SHA-256</dt>
        <dd className="break-all font-mono text-xs" data-testid="import-sha">
          {report.contentSha256}
        </dd>
        <dt className="text-muted-foreground">Total credit balance</dt>
        <dd data-testid="import-total-balance">{formatUsd(report.totalBalanceMicros)}</dd>
        <dt className="text-muted-foreground">Unredeemed invitation codes</dt>
        <dd>{report.counts.inviteCodesUnredeemed ?? 0}</dd>
      </dl>

      {report.refusals.length > 0 ? (
        <ul
          className="grid gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-3"
          data-testid="import-refusals"
        >
          {report.refusals.map((refusal) => (
            <li key={refusal}>{refusal}</li>
          ))}
        </ul>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Section</TableHead>
            <TableHead className="text-right">In the file</TableHead>
            <TableHead className="text-right">{report.applied ? 'Created' : 'Will be created'}</TableHead>
            <TableHead className="text-right">Already here</TableHead>
            <TableHead className="text-right">Collisions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.sections.map((section) => (
            <TableRow key={section.section} data-testid={`import-section-${section.section}`}>
              <TableCell>{SECTION_LABELS[section.section] ?? section.section}</TableCell>
              <TableCell className="text-right tabular-nums">{section.inBundle}</TableCell>
              <TableCell className="text-right tabular-nums">{section.toCreate}</TableCell>
              <TableCell className="text-right tabular-nums">{section.alreadyPresent}</TableCell>
              <TableCell
                className={`text-right tabular-nums ${section.conflicts.length > 0 ? 'text-destructive' : ''}`}
              >
                {section.conflicts.length}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {conflicts.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-destructive" data-testid="import-conflicts">
          {conflicts.map((conflict) => (
            <li key={conflict}>{conflict}</li>
          ))}
        </ul>
      ) : null}

      {report.notes.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground" data-testid="import-notes">
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      {report.applied ? (
        <p data-testid="import-next-steps">
          Everyone signs in again on this deployment with their email address; balances and unredeemed invitation codes
          work as before. API keys were not carried over — each person issues new ones under API Keys.
        </p>
      ) : null}
    </div>
  );
}
