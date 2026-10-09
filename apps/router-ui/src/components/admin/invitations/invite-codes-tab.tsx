'use client';

import { useMutation, useQuery } from '@apollo/client/react';
import { Badge } from '@confidential-router/ui/components/badge';
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
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import { Label } from '@confidential-router/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@confidential-router/ui/components/select';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@confidential-router/ui/components/table';
import { Ticket } from 'lucide-react';
import * as React from 'react';
import type { AdminInviteCodesQuery, InviteCodeStatus } from '../../../generated/graphql';
import { formatDate, formatUsdShort } from '../../../lib/format';
import { errorMessageOf } from '../../../lib/graphql-error';
import { maskCode, PAGE_SIZE, pageRange, STATUS_LABEL, STATUS_VARIANT } from './invitations';
import { MaskedCode } from './masked-code';
import { ADMIN_INVITE_CODES_QUERY, INVITE_STATISTICS_QUERY, WITHDRAW_INVITE_CODE } from './operations';

type InviteCode = AdminInviteCodesQuery['adminInviteCodes']['nodes'][number];

/** `Select` cannot hold an empty value, so "no filter" is a sentinel. */
const ALL = 'all';

const STATUSES: InviteCodeStatus[] = ['ACTIVE', 'REDEEMED', 'EXPIRED', 'WITHDRAWN'];

function WithdrawDialog({ code, onOpenChange }: { code: InviteCode | null; onOpenChange: (open: boolean) => void }) {
  const [failure, setFailure] = React.useState<string | null>(null);
  const [withdraw, { loading }] = useMutation(WITHDRAW_INVITE_CODE, {
    refetchQueries: [ADMIN_INVITE_CODES_QUERY, INVITE_STATISTICS_QUERY],
    awaitRefetchQueries: true,
  });

  if (!code) return null;

  const confirm = async () => {
    setFailure(null);
    try {
      await withdraw({ variables: { id: code.id } });
      onOpenChange(false);
    } catch (caught) {
      setFailure(errorMessageOf(caught));
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Withdraw this code?</DialogTitle>
          <DialogDescription>
            No one will be able to sign up with it from now on. Credit it already granted is not affected.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          <span className="font-mono">{maskCode(code.code)}</span> · {code.campaign} ·{' '}
          {formatUsdShort(code.grantMicros)}
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
            {loading ? 'Withdrawing…' : 'Withdraw code'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Every code, newest first: what it grants, where it stands, and who redeemed it
 * — the "which user came from which code" answer, from the code's side (SUP-268).
 */
export function InviteCodesTab({ campaigns }: { campaigns: string[] }) {
  const [campaign, setCampaign] = React.useState(ALL);
  const [status, setStatus] = React.useState<InviteCodeStatus | typeof ALL>(ALL);
  const [offset, setOffset] = React.useState(0);
  const [withdrawingId, setWithdrawingId] = React.useState<string | null>(null);

  const { data, loading, error, refetch } = useQuery(ADMIN_INVITE_CODES_QUERY, {
    variables: {
      campaign: campaign === ALL ? null : campaign,
      status: status === ALL ? null : status,
      offset,
      limit: PAGE_SIZE,
    },
    fetchPolicy: 'cache-and-network',
  });

  const page = data?.adminInviteCodes;
  const codes = page?.nodes ?? [];
  const withdrawing = codes.find((code) => code.id === withdrawingId) ?? null;

  const filters = (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="codes-campaign">Campaign</Label>
        <Select
          value={campaign}
          onValueChange={(value) => {
            setCampaign(value);
            setOffset(0);
          }}
        >
          <SelectTrigger id="codes-campaign" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All campaigns</SelectItem>
            {campaigns.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="codes-status">Status</Label>
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value as InviteCodeStatus | typeof ALL);
            setOffset(0);
          }}
        >
          <SelectTrigger id="codes-status" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any status</SelectItem>
            {STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {STATUS_LABEL[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );

  if (error && !data) {
    return (
      <>
        {filters}
        <ErrorState
          title="The codes could not be loaded"
          description="The console could not read this deployment's invitation codes."
          detail="AdminInviteCodes"
          onRetry={() => void refetch()}
        />
      </>
    );
  }

  return (
    <>
      {filters}

      {loading && !page ? (
        <div className="space-y-2" data-testid="invite-codes-loading">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : codes.length === 0 ? (
        <EmptyState
          icon={<Ticket className="size-5" aria-hidden="true" />}
          title={campaign === ALL && status === ALL ? 'No invitation codes yet' : 'No codes match these filters'}
          description={
            campaign === ALL && status === ALL
              ? 'Issue a code or a batch and it appears here, with whoever redeems it.'
              : 'Try another campaign or status.'
          }
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <Table aria-label="Invitation codes">
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Issued</TableHead>
                  <TableHead>Redeemed by</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {codes.map((code) => (
                  <TableRow key={code.id} data-testid={`invite-code-row-${code.id}`}>
                    <TableCell>
                      <MaskedCode code={code.code} />
                    </TableCell>
                    <TableCell className="max-w-56 text-sm">
                      <span className="block truncate font-mono text-xs">{code.campaign}</span>
                      {code.note ? (
                        <span className="block truncate text-muted-foreground text-xs" title={code.note}>
                          {code.note}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatUsdShort(code.grantMicros)}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[code.status]}>{STATUS_LABEL[code.status]}</Badge>
                      {code.maxRedemptions > 1 ? (
                        <span className="ml-1.5 text-muted-foreground text-xs">
                          {code.redemptionCount}/{code.maxRedemptions}
                        </span>
                      ) : null}
                      {code.status === 'ACTIVE' && code.expiresAt ? (
                        <span className="block text-muted-foreground text-xs">until {formatDate(code.expiresAt)}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      <span className="block">{formatDate(code.createdAt)}</span>
                      <span className="block">{code.issuedByEmail ?? 'CLI'}</span>
                    </TableCell>
                    <TableCell className="text-xs">
                      {code.redeemers.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        code.redeemers.map((redeemer) => (
                          <span key={redeemer.userId} className="block">
                            {redeemer.email ?? <span className="text-muted-foreground">deleted account</span>}
                            <span className="text-muted-foreground"> · {formatDate(redeemer.redeemedAt)}</span>
                          </span>
                        ))
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex items-center gap-1">
                        <CopyButton value={code.url} label={`Copy the invitation link for ${maskCode(code.code)}`} />
                        {code.status === 'ACTIVE' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setWithdrawingId(code.id)}
                            aria-label={`Withdraw code ${maskCode(code.code)}`}
                          >
                            Withdraw
                          </Button>
                        ) : null}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 text-muted-foreground text-sm">
            <span>{pageRange(offset, codes.length, page?.totalCount ?? 0)}</span>
            <span className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + codes.length >= (page?.totalCount ?? 0)}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </span>
          </div>
        </>
      )}

      <WithdrawDialog code={withdrawing} onOpenChange={(open) => !open && setWithdrawingId(null)} />
    </>
  );
}
