'use client';

import { useMutation, useQuery } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@confidential-router/ui/components/dialog';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@confidential-router/ui/components/table';
import { Plus, ShieldCheck } from 'lucide-react';
import * as React from 'react';
import type { TrustedMeasurementsQuery } from '../../generated/graphql';
import { formatTimestamp, shortenDigest } from '../../lib/format';
import { errorMessageOf } from '../../lib/graphql-error';
import { PageHeader } from '../page-header';
import { useViewerIsAdmin } from '../session/use-viewer-is-admin';
import { AdminReadOnlyNotice } from './admin-gate';
import { ADD_TRUSTED_MEASUREMENT, REMOVE_TRUSTED_MEASUREMENT, TRUSTED_MEASUREMENTS_QUERY } from './operations';
import { CLOUD_GRANULARITY_WARNING, CloudGranularityWarning, REMOVAL_WARNING } from './trust-copy';

type Measurement = TrustedMeasurementsQuery['trustedMeasurements'][number];

/** 64 lower-case hex characters — the normalised mrEnclave form the list stores. */
const MEASUREMENT_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Normalises what an operator actually pastes: a measurement copied out of a
 * verification report arrives with a `0x` prefix, upper case, or wrapped in
 * whitespace, and none of those is a different value.
 */
export function normaliseMeasurement(input: string): string {
  return input.trim().toLowerCase().replace(/^0x/, '').replace(/\s+/g, '');
}

export function measurementError(input: string): string | null {
  const value = normaliseMeasurement(input);
  if (value === '') return 'A measurement is required.';
  if (!MEASUREMENT_PATTERN.test(value)) return 'A measurement is 64 hexadecimal characters.';
  return null;
}

function AddMeasurementDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [measurement, setMeasurement] = React.useState('');
  const [note, setNote] = React.useState('');
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);

  const [add, { loading }] = useMutation(ADD_TRUSTED_MEASUREMENT, {
    refetchQueries: [{ query: TRUSTED_MEASUREMENTS_QUERY }],
    awaitRefetchQueries: true,
  });

  const reset = () => {
    setMeasurement('');
    setNote('');
    setFieldError(null);
    setFailure(null);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);

    const invalid = measurementError(measurement);
    setFieldError(invalid);
    if (invalid) return;

    try {
      await add({
        variables: {
          input: { measurement: normaliseMeasurement(measurement), note: note.trim() === '' ? null : note.trim() },
        },
      });
      onOpenChange(false);
      reset();
    } catch (caught) {
      setFailure(errorMessageOf(caught));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Trust a measurement</DialogTitle>
          <DialogDescription>{CLOUD_GRANULARITY_WARNING}</DialogDescription>
        </DialogHeader>

        <CloudGranularityWarning />

        <form id="add-measurement-form" className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div>
            <Label htmlFor="measurement">Launch measurement</Label>
            <Input
              id="measurement"
              value={measurement}
              onChange={(event) => {
                setMeasurement(event.target.value);
                setFieldError(null);
              }}
              placeholder="64 hexadecimal characters"
              className="font-mono"
              aria-describedby={fieldError ? 'measurement-error' : 'measurement-help'}
              aria-invalid={Boolean(fieldError)}
              disabled={loading}
              autoComplete="off"
              spellCheck={false}
            />
            <p id="measurement-help" className="mt-1 text-muted-foreground text-xs">
              The normalised mrEnclave of the upstream cloud's root — the value a verification report prints. A leading{' '}
              <span className="font-mono">0x</span> and upper case are accepted.
            </p>
            {fieldError ? (
              <p id="measurement-error" role="alert" className="mt-1 text-destructive text-xs">
                {fieldError}
              </p>
            ) : null}
          </div>

          <div>
            <Label htmlFor="measurement-note">Note</Label>
            <Input
              id="measurement-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Why this cloud is trusted"
              disabled={loading}
              autoComplete="off"
            />
            <p className="mt-1 text-muted-foreground text-xs">
              Optional, and shown beside the entry. Every trust change is recorded with the operator who made it.
            </p>
          </div>

          {failure ? (
            <p role="alert" className="text-destructive text-sm">
              {failure}
            </p>
          ) : null}
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" form="add-measurement-form" variant="brand" disabled={loading}>
            {loading ? 'Adding…' : 'Trust this measurement'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoveMeasurementDialog({
  measurement,
  onOpenChange,
}: {
  measurement: Measurement | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [failure, setFailure] = React.useState<string | null>(null);

  const [remove, { loading }] = useMutation(REMOVE_TRUSTED_MEASUREMENT, {
    refetchQueries: [{ query: TRUSTED_MEASUREMENTS_QUERY }],
    awaitRefetchQueries: true,
  });

  if (!measurement) return null;

  const confirm = async () => {
    setFailure(null);
    try {
      await remove({ variables: { id: measurement.id } });
      onOpenChange(false);
    } catch (caught) {
      setFailure(errorMessageOf(caught));
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Remove this measurement?</DialogTitle>
          <DialogDescription>{REMOVAL_WARNING}</DialogDescription>
        </DialogHeader>

        <p className="break-all font-mono text-sm">{measurement.measurement}</p>
        <p className="text-sm">
          {measurement.admits === 0
            ? 'No registered endpoint was admitted by this measurement at its last check.'
            : `${measurement.admits} registered endpoint${measurement.admits === 1 ? '' : 's'} ${
                measurement.admits === 1 ? 'was' : 'were'
              } admitted by this measurement at the last check, and will be denied on the next one.`}
        </p>

        {failure ? (
          <p role="alert" className="text-destructive text-sm">
            {failure}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={() => void confirm()} disabled={loading}>
            {loading ? 'Removing…' : 'Remove measurement'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TrustListScreen() {
  /* Only the flag — see the note in `external-endpoints-screen.tsx`. */
  const isAdmin = useViewerIsAdmin();

  const { data, loading, error, refetch } = useQuery(TRUSTED_MEASUREMENTS_QUERY, { fetchPolicy: 'cache-and-network' });

  const [adding, setAdding] = React.useState(false);
  const [removingId, setRemovingId] = React.useState<string | null>(null);

  const measurements = data?.trustedMeasurements ?? [];
  const removing = measurements.find((entry) => entry.id === removingId) ?? null;

  const header = (
    <PageHeader
      title="Trust list"
      description="The launch measurements this deployment accepts for an external upstream. An endpoint is trusted if and only if its evidence verifies and the measurement it presents is on this list — nothing else admits."
      actions={
        isAdmin ? (
          <Button variant="brand" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            Trust a measurement
          </Button>
        ) : null
      }
    />
  );

  if (error && !data) {
    return (
      <>
        {header}
        <ErrorState
          title="The trust list could not be loaded"
          description="The console could not read this deployment's trusted measurements."
          detail="TrustedMeasurements"
          onRetry={() => void refetch()}
        />
      </>
    );
  }

  return (
    <>
      {header}

      <div className="mb-4 space-y-3">
        <CloudGranularityWarning>
          <p className="text-muted-foreground">{REMOVAL_WARNING}</p>
        </CloudGranularityWarning>
        {isAdmin ? null : <AdminReadOnlyNotice />}
      </div>

      {loading && measurements.length === 0 ? (
        <div className="space-y-2" data-testid="trust-list-loading">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : measurements.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="size-5" aria-hidden="true" />}
          title="No measurements trusted"
          description="Until a measurement is on this list, no external endpoint can verify, so none of them can serve a request. That is the fail-closed default."
          action={
            isAdmin ? (
              <Button variant="brand" onClick={() => setAdding(true)}>
                <Plus aria-hidden="true" />
                Trust a measurement
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Measurement</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>Added by</TableHead>
                <TableHead>Added</TableHead>
                <TableHead>Admits</TableHead>
                {isAdmin ? <TableHead className="text-right">Actions</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {measurements.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="font-mono text-xs">
                    <span title={entry.measurement}>{shortenDigest(entry.measurement, 10)}</span>
                  </TableCell>
                  <TableCell className="max-w-72 text-sm">
                    {entry.note ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{entry.addedByEmail ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{formatTimestamp(entry.addedAt)}</TableCell>
                  <TableCell className="text-sm">
                    {entry.admits} endpoint{entry.admits === 1 ? '' : 's'}
                  </TableCell>
                  {isAdmin ? (
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRemovingId(entry.id)}
                        aria-label={`Remove measurement ${shortenDigest(entry.measurement, 6)}`}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {isAdmin ? (
        <>
          <AddMeasurementDialog open={adding} onOpenChange={setAdding} />
          <RemoveMeasurementDialog measurement={removing} onOpenChange={(open) => !open && setRemovingId(null)} />
        </>
      ) : null}
    </>
  );
}
