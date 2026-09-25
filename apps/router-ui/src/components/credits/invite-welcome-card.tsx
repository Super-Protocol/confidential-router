'use client';

import { useQuery } from '@apollo/client/react';
import { Card, CardContent } from '@confidential-router/ui/components/card';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { CircleAlert, Gift } from 'lucide-react';
import * as React from 'react';
import type { InviteRefusalReason } from '../../generated/graphql';
import { formatUsdShort } from '../../lib/format';
import { forgetInvite, readInviteCode } from '../../lib/invite';
import { INVITE_GRANT_STATUS_QUERY } from '../invites/operations';

/**
 * Why there is no credit, in the viewer's terms.
 *
 * One sentence per reason, and none of them says "error" or "invalid": the person
 * reading this has just created an account off the back of a mailed link, and the
 * only useful thing to tell them is whether the link is still worth anything and
 * what to do if it is not. Every one of them also has to make clear that the
 * account itself is fine — a registration is never failed over a code (SUP-142).
 */
const REFUSALS: Record<InviteRefusalReason, string> = {
  EXPIRED:
    'That invitation had expired, so no credit was added. Your account is ready either way — ask us for a fresh link, or top up whenever you like.',
  EXHAUSTED:
    'That invitation had already been claimed, so no credit was added. Invitations are good for one account. Your account is ready either way.',
  DISABLED:
    'That invitation is no longer active, so no credit was added. Your account is ready either way — ask us for a fresh link.',
  NOT_FOUND:
    'We did not recognise that invitation code, so no credit was added. Check the link in your invitation, or ask us for a new one.',
  ALREADY_REDEEMED:
    'This account already has its invitation credit — one per account. The code you just used has not been spent.',
  ERROR:
    'Something went wrong applying your invitation, so no credit was added yet. Your account is ready; tell us the code and we will sort it out.',
};

/**
 * The first thing an invited visitor sees after registering: whether the $100 is
 * there.
 *
 * It exists because the sign-up response cannot say. Better Auth owns that
 * response and the grant happens inside the hook behind it, so the outcome is not
 * in it by construction — the console has to ask, and `inviteGrantStatus` is the
 * question (SUP-142). Which is also why a refusal is a message here rather than an
 * error on the sign-up form: by the time we know, the account exists.
 *
 * The stored code is dropped as soon as the answer arrives, whichever it is. A
 * spent code left in `localStorage` would greet the next person to use this
 * browser with someone else's invitation.
 */
export function InviteWelcomeCard(): React.ReactElement | null {
  const [code] = React.useState(() => readInviteCode(globalThis.location?.search ?? ''));

  const { data, loading } = useQuery(INVITE_GRANT_STATUS_QUERY, {
    variables: { code },
    // The grant is written inside account creation, which finished before this
    // page loaded — but a cached answer from an earlier visit would be the wrong
    // one after the second code of the `ALREADY_REDEEMED` case.
    fetchPolicy: 'network-only',
  });

  const status = data?.inviteGrantStatus;

  React.useEffect(() => {
    if (status) forgetInvite();
  }, [status]);

  if (loading && !data) {
    return <Skeleton className="h-20 w-full" data-testid="invite-welcome-loading" />;
  }

  // Nothing happened and nothing was promised: an ordinary sign-up, or a reload of
  // this URL long after the fact.
  if (!status || (!status.grant && !status.reason)) {
    return null;
  }

  const refusal = status.reason ? REFUSALS[status.reason] : null;

  return (
    <Card
      className={status.grant ? 'border-brand-border bg-brand-muted' : undefined}
      data-testid={status.grant ? 'invite-granted' : 'invite-refused'}
    >
      <CardContent className="flex items-start gap-3 py-4">
        {status.grant ? (
          <Gift className="mt-0.5 size-4 shrink-0 text-brand-emphasis" aria-hidden="true" />
        ) : (
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <div className="min-w-0 space-y-1">
          {status.grant ? (
            <p className="font-medium text-sm">
              {formatUsdShort(status.grant.grantMicros)} in credits is in your account.
            </p>
          ) : null}
          {status.grant ? (
            <p className="text-muted-foreground text-sm leading-relaxed">
              From the <span className="font-mono">{status.grant.campaign}</span> invitation — it is the{' '}
              <span className="font-medium text-foreground">grant</span> entry in the ledger below. Nothing expires and
              there is no card on file.
            </p>
          ) : null}
          {refusal ? (
            <p className="text-sm leading-relaxed" role="status">
              {refusal}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
