'use client';

import { useQuery } from '@apollo/client/react';
import { Badge } from '@confidential-router/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import type { MailDeliveryQuery } from '../../../generated/graphql';
import { formatCount } from '../../../lib/metrics';
import { MAIL_DELIVERY_QUERY } from './operations';

type Delivery = MailDeliveryQuery['mailDelivery'];

const TRANSPORT: Record<Delivery['state'], { label: string; variant: 'success' | 'secondary' | 'destructive' }> = {
  OK: { label: 'Working', variant: 'success' },
  UNVERIFIED: { label: 'Not checked yet', variant: 'secondary' },
  DISABLED: { label: 'No mailer configured', variant: 'secondary' },
  FAILING: { label: 'Failing', variant: 'destructive' },
};

const FAILURE: Record<string, string> = {
  UNREACHABLE: 'The mail server could not be reached from this deployment at all.',
  AUTH_FAILED: 'The mail server refused the configured credentials.',
  REJECTED: 'The mail server refused the message itself.',
  ERROR: 'The last send failed; the log has the server’s own words.',
};

/**
 * "The sign-in mail is not arriving" — every answer, side by side (SUP-462).
 *
 * The operator's problem was never that any one of these is hard to read. It is
 * that a *withheld* send and a dead mail server look the same from outside: the
 * send route answers a refusal exactly as it answers a send, deliberately and
 * correctly, because an observable refusal is an account-existence oracle. On a
 * published cluster space the only record was a log line nobody can reach, so
 * five withheld codes read as "production has stopped sending" — a false
 * incident, and about a session of two agents hunting an egress fault that did
 * not exist.
 *
 * Counts only, never addresses: a list of withheld addresses would rebuild the
 * oracle the gate is there to deny.
 */
export function MailDeliveryCard() {
  const { data, error, refetch } = useQuery(MAIL_DELIVERY_QUERY, { fetchPolicy: 'cache-and-network' });

  // Said, not hidden. This is the only place a withheld send is visible, so a
  // panel that quietly disappeared when the query failed would put the operator
  // back where SUP-462 found them — reading nothing and inferring an outage.
  if (error && !data) {
    return (
      <ErrorState
        title="Mail delivery could not be read"
        description="The console could not read whether this deployment is sending, withholding, or failing to send."
        detail="MailDelivery"
        onRetry={() => void refetch()}
        data-testid="mail-delivery-error"
      />
    );
  }

  return (
    <Card data-testid="mail-delivery">
      <CardHeader className="border-b pb-4">
        <CardTitle className="text-sm">Sign-up mail</CardTitle>
        <CardDescription>
          Since this API replica started. A withheld send is answered exactly like a sent one, so the count is the only
          place it shows.
        </CardDescription>
      </CardHeader>
      <CardContent>{data ? <Rows delivery={data.mailDelivery} /> : <Skeleton className="h-24 w-full" />}</CardContent>
    </Card>
  );
}

function Rows({ delivery }: { delivery: Delivery }) {
  const transport = TRANSPORT[delivery.state];
  const withheld = delivery.withheld;

  return (
    <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <div>
        <dt className="flex items-center gap-2 text-muted-foreground text-sm">
          Transport
          <Badge variant={transport.variant}>{transport.label}</Badge>
        </dt>
        <dd className="mt-1 text-muted-foreground text-xs">
          {delivery.state === 'FAILING' && delivery.reason
            ? FAILURE[delivery.reason]
            : `Provider: ${delivery.provider.toLowerCase()}.`}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground text-sm">Withheld — no invitation</dt>
        <dd className="mt-1 font-mono font-semibold text-2xl tracking-tight" data-testid="withheld-no-invitation">
          {formatCount(withheld?.noInvitation ?? 0)}
        </dd>
        <dd className="mt-0.5 text-muted-foreground text-xs">
          {delivery.inviteOnly
            ? 'Uninvited addresses that asked for a sign-in code. Not an outage — nothing was sent, on purpose.'
            : 'Registration is open on this deployment, so nothing is withheld for want of an invitation.'}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground text-sm">Withheld — hourly allowance</dt>
        <dd className="mt-1 font-mono font-semibold text-2xl tracking-tight" data-testid="withheld-rate-limited">
          {formatCount(withheld?.rateLimited ?? 0)}
        </dd>
        <dd className="mt-0.5 text-muted-foreground text-xs">
          Recipients already at <code className="font-mono">mailsPerAddressPerHour</code>.
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground text-sm">Withheld — unused code type</dt>
        <dd className="mt-1 font-mono font-semibold text-2xl tracking-tight" data-testid="withheld-unused-type">
          {formatCount(withheld?.unusedCodeType ?? 0)}
        </dd>
        <dd className="mt-0.5 text-muted-foreground text-xs">
          Requests for a code type this deployment does not mail. Anything but zero is a client asking wrongly.
        </dd>
      </div>
    </dl>
  );
}
