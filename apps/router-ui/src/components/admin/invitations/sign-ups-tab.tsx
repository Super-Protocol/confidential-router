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
import {
  accountsHolding,
  apiKeyCount,
  KEY_FILTER,
  KEY_FILTER_LABEL,
  type KeyFilter,
  ORIGIN_LABEL,
  ORIGIN_VARIANT,
  PAGE_SIZE,
  pageRange,
} from './invitations';
import { MaskedCode } from './masked-code';
import { ADMIN_API_KEY_POPULATION_QUERY, ADMIN_SIGN_UPS_QUERY } from './operations';

const ALL = 'all';
const ORIGINS: SignUpOrigin[] = ['INVITE', 'BOOTSTRAP', 'OPEN'];
const KEY_FILTERS = Object.keys(KEY_FILTER) as KeyFilter[];

/**
 * Every account, newest first, with how it came to exist — the "which user came
 * from which code" answer from the account's side (SUP-268) — and how many `/v1`
 * keys it holds (SUP-454).
 *
 * This is the console's only list of accounts, so it is where the per-user facts
 * live: there is no separate admin user directory for them to join. The
 * credentials are counts and a last-used instant, never a key or a prefix: what
 * an operator needs before a key-affecting change is who must re-issue, and the
 * "Holds a live key" filter turns the pager's total into exactly that number.
 */
export function SignUpsTab() {
  const [origin, setOrigin] = React.useState<SignUpOrigin | typeof ALL>(ALL);
  const [keys, setKeys] = React.useState<KeyFilter>('all');
  const [offset, setOffset] = React.useState(0);

  const { data, loading, error, refetch } = useQuery(ADMIN_SIGN_UPS_QUERY, {
    variables: {
      origin: origin === ALL ? null : origin,
      holdsLiveApiKey: KEY_FILTER[keys],
      offset,
      limit: PAGE_SIZE,
    },
    fetchPolicy: 'cache-and-network',
  });

  const page = data?.adminSignUps;
  const signUps = page?.nodes ?? [];

  const filters = (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="grid gap-1.5">
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
      <div className="grid gap-1.5">
        <Label htmlFor="sign-ups-keys">API keys</Label>
        <Select
          value={keys}
          onValueChange={(value) => {
            setKeys(value as KeyFilter);
            setOffset(0);
          }}
        >
          <SelectTrigger id="sign-ups-keys" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KEY_FILTERS.map((value) => (
              <SelectItem key={value} value={value}>
                {KEY_FILTER_LABEL[value]}
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
      <KeyPopulation />

      {loading && !page ? (
        <div className="space-y-2" data-testid="sign-ups-loading">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : signUps.length === 0 ? (
        <EmptyState icon={<UsersRound className="size-5" aria-hidden="true" />} title={emptyTitle(origin, keys)} />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <Table aria-label="Sign-ups">
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Signed up</TableHead>
                  <TableHead>Origin</TableHead>
                  <TableHead>API keys</TableHead>
                  <TableHead>Key last used</TableHead>
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
                    <TableCell className="text-sm">
                      {apiKeyCount(signUp.apiKeys) ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDate(signUp.apiKeys.lastUsedAt)}
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

/**
 * The deployment-wide credential total, above the list (SUP-454).
 *
 * Its own query because a page cannot be summed into it: a key in a shared
 * workspace belongs to every member, and a key in a workspace nobody is left in
 * belongs to no row of this table at all — which is the one number here an
 * operator cannot act on, so it is said out loud rather than left implied.
 *
 * Silent on failure. The table below it is the screen's job; a deployment total
 * the API would not answer is not worth an error state over the account list.
 */
function KeyPopulation() {
  const { data } = useQuery(ADMIN_API_KEY_POPULATION_QUERY, { fetchPolicy: 'cache-and-network' });
  const population = data?.adminApiKeyPopulation;

  if (!population) {
    return null;
  }

  return (
    <p className="mb-4 text-muted-foreground text-sm" data-testid="api-key-population">
      {population.accountsHoldingLiveKey === 0
        ? 'No account here holds a live API key.'
        : `${accountsHolding(population.accountsHoldingLiveKey)} a live API key — ${population.liveKeys} live of ${
            population.keys
          } ever issued.`}
      {population.liveKeysWithoutAccount > 0
        ? ` ${population.liveKeysWithoutAccount} live ${
            population.liveKeysWithoutAccount === 1 ? 'key belongs' : 'keys belong'
          } to a workspace with no account, so no one here can be told about ${
            population.liveKeysWithoutAccount === 1 ? 'it' : 'them'
          }.`
        : null}
    </p>
  );
}

/**
 * An empty page says what was asked for, never what that implies.
 *
 * "No live key" coming back empty does not mean every account holds one: the
 * origin filter may be what emptied it, and a deployment whose first account
 * signed up by invite has no Bootstrap account at all — so there both credential
 * filters are empty for a reason that has nothing to do with keys.
 */
function emptyTitle(origin: SignUpOrigin | typeof ALL, keys: KeyFilter): string {
  if (keys !== 'all') {
    return 'No accounts match these filters';
  }
  return origin === ALL ? 'No accounts yet' : `No ${ORIGIN_LABEL[origin].toLowerCase()} accounts`;
}
