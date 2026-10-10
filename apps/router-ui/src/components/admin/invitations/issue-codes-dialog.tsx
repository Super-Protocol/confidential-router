'use client';

import { useMutation } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { CopyButton } from '@confidential-router/ui/components/copy-button';
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
import { Download } from 'lucide-react';
import * as React from 'react';
import type { IssueInviteCodesMutation } from '../../../generated/graphql';
import { formatDate, formatUsdShort, usdToMicros } from '../../../lib/format';
import { errorMessageOf } from '../../../lib/graphql-error';
import {
  campaignError,
  expiryFromDate,
  invitesCsv,
  invitesText,
  MAX_ISSUE_COUNT,
  MAX_ISSUE_GRANT_USD,
} from './invitations';
import { ADMIN_INVITE_CODES_QUERY, INVITE_STATISTICS_QUERY, ISSUE_INVITE_CODES } from './operations';

type Issued = IssueInviteCodesMutation['issueInviteCodes'];

interface FormState {
  count: string;
  credit: string;
  campaign: string;
  maxRedemptions: string;
  expires: string;
  note: string;
}

const INITIAL: FormState = { count: '1', credit: '100', campaign: '', maxRedemptions: '1', expires: '', note: '' };

type FieldErrors = Partial<Record<keyof FormState, string>>;

function wholeNumber(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

/** The form's rules — the API's, said before the round trip rather than after it. */
export function validateIssueForm(form: FormState, today: string): FieldErrors {
  const errors: FieldErrors = {};
  if (wholeNumber(form.count, 1, MAX_ISSUE_COUNT) === null) {
    errors.count = `Between 1 and ${MAX_ISSUE_COUNT} codes per batch.`;
  }
  const micros = usdToMicros(form.credit);
  if (micros === null || BigInt(micros) <= 0n || BigInt(micros) > BigInt(MAX_ISSUE_GRANT_USD) * 1_000_000n) {
    errors.credit = `A dollar amount above $0 and at most $${MAX_ISSUE_GRANT_USD.toLocaleString('en-US')}.`;
  }
  const campaign = campaignError(form.campaign.trim());
  if (campaign) errors.campaign = campaign;
  if (wholeNumber(form.maxRedemptions, 1, 10_000) === null) {
    errors.maxRedemptions = 'At least 1 account per code.';
  }
  if (form.expires !== '' && (expiryFromDate(form.expires) === null || form.expires < today)) {
    errors.expires = 'Pick today or a later date.';
  }
  return errors;
}

function downloadCsv(issued: Issued): void {
  const blob = new Blob([invitesCsv(issued.codes)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `invites-${issued.campaign}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Issues one code or a batch, then shows the batch exactly once (SUP-268).
 *
 * "Once" is about the moment, not about secrecy: the codes list can reveal any
 * code later. But this is the screen an operator copies a mailing from, so it
 * shows every code and link in full, with copy-all and the same CSV the CLI
 * writes.
 */
export function IssueCodesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [form, setForm] = React.useState<FormState>(INITIAL);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [issued, setIssued] = React.useState<Issued | null>(null);

  const [issue, { loading }] = useMutation(ISSUE_INVITE_CODES, {
    refetchQueries: [ADMIN_INVITE_CODES_QUERY, INVITE_STATISTICS_QUERY],
  });

  const reset = () => {
    setForm(INITIAL);
    setErrors({});
    setFailure(null);
    setIssued(null);
  };

  const set = (field: keyof FormState) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    const found = validateIssueForm(form, new Date().toISOString().slice(0, 10));
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    try {
      const result = await issue({
        variables: {
          input: {
            count: Number(form.count),
            grantMicros: usdToMicros(form.credit) as string,
            campaign: form.campaign.trim(),
            maxRedemptions: Number(form.maxRedemptions),
            expiresAt: form.expires === '' ? null : expiryFromDate(form.expires),
            note: form.note.trim() === '' ? null : form.note.trim(),
          },
        },
      });
      setIssued(result.data?.issueInviteCodes ?? null);
    } catch (caught) {
      setFailure(errorMessageOf(caught));
    }
  };

  const field = (
    name: keyof FormState,
    label: string,
    { help, ...props }: React.ComponentProps<typeof Input> & { help?: string } = {},
  ) => (
    <div>
      <Label htmlFor={`issue-${name}`}>{label}</Label>
      <Input
        id={`issue-${name}`}
        value={form[name]}
        onChange={set(name)}
        disabled={loading}
        aria-invalid={Boolean(errors[name])}
        aria-describedby={errors[name] ? `issue-${name}-error` : help ? `issue-${name}-help` : undefined}
        autoComplete="off"
        {...props}
      />
      {errors[name] ? (
        <p id={`issue-${name}-error`} role="alert" className="mt-1 text-destructive text-xs">
          {errors[name]}
        </p>
      ) : help ? (
        <p id={`issue-${name}-help`} className="mt-1 text-muted-foreground text-xs">
          {help}
        </p>
      ) : null}
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        {issued ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {issued.codes.length === 1
                  ? 'Invitation code issued'
                  : `${issued.codes.length} invitation codes issued`}
              </DialogTitle>
              <DialogDescription>
                {formatUsdShort(issued.grantMicros)} credit each · campaign{' '}
                <span className="font-mono">{issued.campaign}</span>
                {issued.expiresAt ? ` · valid until ${formatDate(issued.expiresAt)}` : ' · no expiry'}. Copy them or
                download the CSV now — this list is not shown again, though each code stays in the codes table.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap gap-2">
              <CopyButton
                value={invitesText(issued.codes)}
                label="Copy all"
                copiedLabel="Copied all"
                showLabel
                variant="outline"
              />
              <Button variant="outline" size="sm" onClick={() => downloadCsv(issued)}>
                <Download aria-hidden="true" />
                Download CSV
              </Button>
            </div>

            <ul
              className="max-h-72 divide-y overflow-y-auto rounded-lg border text-xs"
              aria-label="Issued invitation codes"
            >
              {issued.codes.map((invite) => (
                <li key={invite.id} className="flex items-center gap-3 px-3 py-1.5">
                  <span className="shrink-0 font-mono" data-testid="issued-code">
                    {invite.code}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={invite.url}>
                    {invite.url}
                  </span>
                  <CopyButton value={invite.url} label={`Copy the link for ${invite.code}`} />
                </li>
              ))}
            </ul>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIssued(null)}>
                Issue more
              </Button>
              <Button type="button" variant="brand" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Issue invitation codes</DialogTitle>
              <DialogDescription>
                Each code credits the account that redeems it at sign-up. Codes can be withdrawn later; credit already
                granted stays where it is.
              </DialogDescription>
            </DialogHeader>

            <form id="issue-codes-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => void submit(event)}>
              {field('count', 'Number of codes', { inputMode: 'numeric', help: `Up to ${MAX_ISSUE_COUNT} per batch.` })}
              {field('credit', 'Credit per code (USD)', { inputMode: 'decimal' })}
              {field('campaign', 'Campaign tag', {
                placeholder: 'launch-2026-10-devs',
                className: 'font-mono',
                spellCheck: false,
                help: 'Groups the batch in the statistics and goes into each link as utm_campaign.',
              })}
              {field('maxRedemptions', 'Accounts per code', {
                inputMode: 'numeric',
                help: '1 for a personal invitation; more for a shared one.',
              })}
              {field('expires', 'Valid through (optional)', {
                type: 'date',
                help: 'Through the end of that day, UTC.',
              })}
              {field('note', 'Note (optional)', { placeholder: 'Who these are for', maxLength: 512 })}

              {failure ? (
                <p role="alert" className="text-destructive text-sm sm:col-span-2">
                  {failure}
                </p>
              ) : null}
            </form>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                Cancel
              </Button>
              <Button type="submit" form="issue-codes-form" variant="brand" disabled={loading}>
                {loading ? 'Issuing…' : 'Issue codes'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
