'use client';

import { useMutation } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import { CreditCard } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { formatUsd, microsToUsdInput } from '../../lib/format';
import { errorMessageOf } from '../../lib/graphql-error';
import { PRESET_TOP_UP_MICROS, parseTopUpAmount } from './amounts';
import { CREATE_CHECKOUT } from './operations';

export interface BuyCreditsCardProps {
  workspaceId: string;
  minTopUpMicros: string;
  /** False for a member: only an owner may spend the workspace's card. */
  canSpend: boolean;
}

/**
 * Preset amounts and a custom one, both of which end in the same Stripe
 * Checkout redirect.
 *
 * The credit is not written here. `createCheckout` only hands back a URL; the
 * balance moves when the provider's webhook confirms the payment, which is why
 * the screen refetches on the `?topup=success` return rather than assuming.
 */
export function BuyCreditsCard({ workspaceId, minTopUpMicros, canSpend }: BuyCreditsCardProps) {
  const [amount, setAmount] = React.useState(() => microsToUsdInput(PRESET_TOP_UP_MICROS[1]));
  const [error, setError] = React.useState<string | null>(null);
  const [createCheckout, { loading }] = useMutation(CREATE_CHECKOUT);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    const parsed = parseTopUpAmount(amount, minTopUpMicros);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);

    try {
      const result = await createCheckout({ variables: { input: { workspaceId, amountMicros: parsed.micros } } });
      const url = result.data?.createCheckout.url;
      if (!url) throw new Error('The payment provider returned no checkout URL.');
      // A full navigation, not a new tab: Checkout comes back to `/credits`
      // with `?topup=…`, and a popup would strand that return in a window the
      // viewer has to find.
      window.location.assign(url);
    } catch (cause) {
      toast.error(errorMessageOf(cause, 'The checkout could not be started.'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Buy credits</CardTitle>
        <CardDescription>
          Paid by card through Stripe. Credit appears on the balance once Stripe confirms the payment.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          <div className="flex flex-wrap gap-2">
            {PRESET_TOP_UP_MICROS.map((micros) => (
              <Button
                key={micros}
                type="button"
                variant="outline"
                size="sm"
                disabled={!canSpend}
                aria-pressed={amount === microsToUsdInput(micros)}
                className="aria-pressed:border-brand aria-pressed:text-brand"
                onClick={() => {
                  setAmount(microsToUsdInput(micros));
                  setError(null);
                }}
              >
                {formatUsd(micros, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </Button>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="topup-amount">Amount (USD)</Label>
            <Input
              id="topup-amount"
              inputMode="decimal"
              value={amount}
              disabled={!canSpend}
              onChange={(event) => setAmount(event.target.value)}
              aria-invalid={error !== null || undefined}
              aria-describedby={error ? 'topup-amount-error' : 'topup-amount-hint'}
            />
            {error ? (
              <p id="topup-amount-error" className="text-destructive text-xs">
                {error}
              </p>
            ) : (
              <p id="topup-amount-hint" className="text-muted-foreground text-xs">
                Minimum {formatUsd(minTopUpMicros)}, in whole cents.
              </p>
            )}
          </div>

          <Button type="submit" variant="brand" className="w-full" disabled={!canSpend || loading}>
            <CreditCard aria-hidden="true" />
            {loading ? 'Opening Stripe…' : 'Add credits'}
          </Button>
          {canSpend ? null : (
            <p className="text-muted-foreground text-xs">
              Only a workspace owner can buy credits. Ask an owner of this workspace to top it up.
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
