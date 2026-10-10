'use client';

import { useApolloClient } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@confidential-router/ui/components/dialog';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import * as React from 'react';
import { type InviteCodesImportReport, importInviteCodesCsv } from '../../../lib/invite-codes-csv';
import { ADMIN_INVITE_CODES_QUERY, INVITE_STATISTICS_QUERY } from './operations';

/** Rows of either list shown before "and N more". */
const LISTED = 8;

const DUPLICATE_REASON = {
  already_present: 'already on this deployment',
  repeated_in_file: 'repeated in the file',
} as const;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

function ReportBody({ report }: { report: InviteCodesImportReport }) {
  const counts = [
    ['Unredeemed', report.toCreate.active, 'Redeemable here, with the same value and credit.'],
    ['Redeemed', report.toCreate.redeemed, 'Recorded as spent; cannot be redeemed again.'],
    ['Withdrawn', report.toCreate.withdrawn, 'Recorded as withdrawn.'],
    ['Expired', report.toCreate.expired, 'Past their expiry.'],
  ] as const;

  return (
    <div className="grid gap-4 text-sm" data-testid="import-report">
      <p>
        {plural(report.totalRows, 'row')} in the file · {plural(report.createCount, 'code')} to import across{' '}
        {plural(report.campaigns, 'campaign')}
      </p>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {counts.map(([label, count, hint]) => (
          <div key={label} className="rounded-lg border px-3 py-2" title={hint}>
            <dt className="text-muted-foreground text-xs">{label}</dt>
            <dd className="font-mono text-lg" data-testid={`import-count-${label.toLowerCase()}`}>
              {count.toLocaleString('en-US')}
            </dd>
          </div>
        ))}
      </dl>

      {report.redemptionsLinked + report.redemptionsUnlinked > 0 ? (
        <p className="text-muted-foreground text-xs">
          {plural(report.redemptionsLinked + report.redemptionsUnlinked, 'past redemption')} carried over:{' '}
          {report.redemptionsLinked.toLocaleString('en-US')} matched to an account here by email,{' '}
          {report.redemptionsUnlinked.toLocaleString('en-US')} kept as an address on the code. No credit is granted for
          them.
        </p>
      ) : null}

      {report.duplicateCount > 0 ? (
        <div>
          <p className="font-medium">{plural(report.duplicateCount, 'duplicate')} skipped, not overwritten</p>
          <ul className="mt-1 text-muted-foreground text-xs" aria-label="Skipped duplicates">
            {report.duplicates.slice(0, LISTED).map((duplicate) => (
              <li key={duplicate.row}>
                Row {duplicate.row} · <span className="font-mono">{duplicate.code}</span> ·{' '}
                {DUPLICATE_REASON[duplicate.reason]}
              </li>
            ))}
            {report.duplicateCount > LISTED ? <li>and {report.duplicateCount - LISTED} more</li> : null}
          </ul>
        </div>
      ) : null}

      {report.errorCount > 0 ? (
        <div role="alert">
          <p className="font-medium text-destructive">
            {plural(report.errorCount, 'malformed row')} — nothing can be imported until the file is fixed
          </p>
          <ul className="mt-1 text-xs" aria-label="Malformed rows">
            {report.errors.slice(0, LISTED).map((error) => (
              <li key={error.row}>
                Row {error.row}: {error.message}
              </li>
            ))}
            {report.errorCount > LISTED ? <li>and {report.errorCount - LISTED} more</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Imports a codes CSV in two steps (SUP-272): the file is read and counted first
 * — per status, duplicates, malformed rows — and nothing is written until the
 * operator confirms that report. The confirmation carries the file's hash, so
 * what is imported is the file that was looked at.
 */
export function ImportCodesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useApolloClient();
  const [csv, setCsv] = React.useState<string | null>(null);
  const [fileName, setFileName] = React.useState('');
  const [report, setReport] = React.useState<InviteCodesImportReport | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const reset = () => {
    setCsv(null);
    setFileName('');
    setReport(null);
    setFailure(null);
    setBusy(false);
  };

  const choose = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    reset();
    if (!file) return;
    setFileName(file.name);
    setBusy(true);
    try {
      const text = await file.text();
      setCsv(text);
      setReport(await importInviteCodesCsv(text));
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!csv || !report) return;
    setFailure(null);
    setBusy(true);
    try {
      setReport(await importInviteCodesCsv(csv, { expect: report.sha256 }));
      await client.refetchQueries({ include: [ADMIN_INVITE_CODES_QUERY, INVITE_STATISTICS_QUERY] });
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const importable = report !== null && report.ok && !report.applied && report.createCount > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{report?.applied ? 'Invitation codes imported' : 'Import invitation codes'}</DialogTitle>
          <DialogDescription>
            {report?.applied
              ? `${plural(report.createCount, 'code')} from ${fileName} are now on this deployment.`
              : 'Choose a CSV exported from the Codes tab of this or another deployment. The file is checked first; nothing is written until you confirm.'}
          </DialogDescription>
        </DialogHeader>

        {report?.applied ? null : (
          <div>
            <Label htmlFor="import-codes-file">Codes CSV</Label>
            <Input
              id="import-codes-file"
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(event) => void choose(event)}
            />
          </div>
        )}

        {busy && !report ? <p className="text-muted-foreground text-sm">Checking the file…</p> : null}
        {report ? <ReportBody report={report} /> : null}
        {report && !report.applied && report.ok && report.createCount === 0 ? (
          <p className="text-muted-foreground text-sm">
            Every code in this file is already here; there is nothing to import.
          </p>
        ) : null}
        {failure ? (
          <p role="alert" className="text-destructive text-sm">
            {failure}
          </p>
        ) : null}

        <DialogFooter>
          {report?.applied ? (
            <Button type="button" variant="brand" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="button" variant="brand" onClick={() => void confirm()} disabled={!importable || busy}>
                {busy && report ? 'Importing…' : importable ? `Import ${plural(report.createCount, 'code')}` : 'Import'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
