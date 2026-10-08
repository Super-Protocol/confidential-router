import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { Gift } from 'lucide-react';

/**
 * What stands where the buy panel goes on a deployment that sells no credit
 * (`billing.provider: disabled`).
 *
 * It replaces the panel rather than disabling it, because a disabled "Add
 * credits" button invites the click that used to work: before SUP-167 the same
 * button, on the same deployment, minted credit from a signed link because the
 * API had fallen back to its development payment provider. The honest screen says
 * buying is off and names the two ways credit does arrive.
 */
export function PurchasesOffCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Buying credits is switched off</CardTitle>
        <CardDescription>This deployment does not sell credit. Nothing here can be paid for by card.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-muted-foreground flex gap-3 text-sm">
          <Gift className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            Credit arrives as a grant: the sign-up credit this deployment may give every new account, an invitation code
            redeemed at sign-up, or the one offered in exchange for feedback. Each lands on the balance above and in the
            ledger below.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
