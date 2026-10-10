'use client';

import { useQuery } from '@apollo/client/react';
import { Badge } from '@confidential-router/ui/components/badge';
import { Button } from '@confidential-router/ui/components/button';
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
import { UsersRound } from 'lucide-react';
import * as React from 'react';
import type { SignUpOrigin } from '../../../generated/graphql';
import { formatDate } from '../../../lib/format';
import { ORIGIN_LABEL, ORIGIN_VARIANT, PAGE_SIZE, pageRange } from './invitations';
import { MaskedCode } from './masked-code';
import { ADMIN_SIGN_UPS_QUERY } from './operations';

const ALL = 'all';
const ORIGINS: SignUpOrigin[] = ['INVITE', 'BOOTSTRAP', 'OPEN'];

/**
 * Every account, newest first, with how it came to exist — the "which user came
 * from which code" answer from the account's side (SUP-268).
 *
 * This is the console's only list of accounts, so it is where the per-user
 * origin lives: there is no separate admin user directory for it to join.
 */
export function SignUpsTab() {
  const [origin, setOrigin] = React.useState<SignUpOrigin | typeof ALL>(ALL);
  const [offset, setOffset] = React.useState(0);

  const { data, loading, error, refetch } = useQuery(ADMIN_SIGN_UPS_QUERY, {
    variables: { origin: origin === ALL ? null : origin, offset, limit: PAGE_SIZE },
    fetchPolicy: 'cache-and-network',
  });

  const page = data?.adminSignUps;
  const signUps = page?.nodes ?? [];

  const filters = (
    <div className="mb-4 grid w-fit gap-1.5">
      <Label htmlFor="sign-ups-origin">Origin</Label>
      <Select
        value={origin}
        onValueChange={(value) => {
          setOrigin(value as SignUpOrigin | typeof ALL);
          setOffset(0);
        }}
      >
        <SelectTrigger id="sign-ups-origin" className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Any origin</SelectItem>
          {ORIGINS.map((value) => (
            <SelectItem key={value} value={value}>
              {ORIGIN_LABEL[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  if (error && !data) {
    return (
      <>
        {filters}
        <ErrorState
          title="The sign-ups could not be loaded"
          description="The console could not read this deployment's accounts."
          detail="AdminSignUps"
          onRetry={() => void refetch()}
        />
      </>
    );
  }

  return (
    <>
      {filters}

      {loading && !page ? (
        <div className="space-y-2" data-testid="sign-ups-loading">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : signUps.length === 0 ? (
        <EmptyState
          icon={<UsersRound className="size-5" aria-hidden="true" />}
          title={origin === ALL ? 'No accounts yet' : `No ${ORIGIN_LABEL[origin].toLowerCase()} accounts`}
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <Table aria-label="Sign-ups">
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Signed up</TableHead>
                  <TableHead>Origin</TableHead>
                  <TableHead>Invitation code</TableHead>
                  <TableHead>Campaign</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {signUps.map((signUp) => (
                  <TableRow key={signUp.userId}>
                    <TableCell className="font-medium text-sm">{signUp.email}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{formatDate(signUp.createdAt)}</TableCell>
                    <TableCell>
                      <Badge variant={ORIGIN_VARIANT[signUp.origin]}>{ORIGIN_LABEL[signUp.origin]}</Badge>
                    </TableCell>
                    <TableCell>
                      {signUp.inviteCode ? (
                        <MaskedCode code={signUp.inviteCode} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {signUp.campaign ?? <span className="font-sans text-muted-foreground">—</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 text-muted-foreground text-sm">
            <span>{pageRange(offset, signUps.length, page?.totalCount ?? 0)}</span>
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
                disabled={offset + signUps.length >= (page?.totalCount ?? 0)}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </span>
          </div>
        </>
      )}
    </>
  );
}
