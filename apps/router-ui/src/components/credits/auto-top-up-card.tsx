'use client';

import { useMutation } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import { Switch } from '@confidential-router/ui/components/switch';
import * as React from 'react';
import { toast } from 'sonner';
import type { CreditBalanceFieldsFragment } from '../../generated/graphql';
import { formatDate, formatUsd, microsToUsdInput } from '../../lib/format';
import { errorMessageOf } from '../../lib/graphql-error';
import { type AutoTopUpErrors, type AutoTopUpFormValues, toAutoTopUpInput, validateAutoTopUp } from './amounts';
import { CREDITS_PAGE_SIZE, CREDITS_QUERY, SET_AUTO_TOP_UP } from './operations';

export interface AutoTopUpCardProps {
  workspaceId: string;
  balance: CreditBalanceFieldsFragment;
  canSpend: boolean;
}

/** What the server currently stores, as one comparable string. */
function settingsKey(balance: CreditBalanceFieldsFragment): string {
  const { enabled, thresholdMicros, amountMicros } = balance.autoTopUp;
  return `${enabled}:${thresholdMicros ?? ''}:${amountMicros ?? ''}`;
}

function formValuesOf(balance: CreditBalanceFieldsFragment): AutoTopUpFormValues {
  return {
    enabled: balance.autoTopUp.enabled,
    threshold: balance.autoTopUp.thresholdMicros ? microsToUsdInput(balance.autoTopUp.thresholdMicros) : '',
    amount: balance.autoTopUp.amountMicros ? microsToUsdInput(balance.autoTopUp.amountMicros) : '',
  };
}

/**
 * Charge the saved card when the balance falls below a threshold.
 *
 * The card itself is Stripe's — it is saved by the first checkout
 * (`setup_future_usage: off_session`), which is why `available` can be false
 * even for an owner: a provider that cannot charge off-session has no card to
 * charge, and the API rejects enabling it.
 */
export function AutoTopUpCard({ workspaceId, balance, canSpend }: AutoTopUpCardProps) {
  const [values, setValues] = React.useState<AutoTopUpFormValues>(() => formValuesOf(balance));
  const [errors, setErrors] = React.useState<AutoTopUpErrors>({});
  const [setAutoTopUp, { loading }] = useMutation(SET_AUTO_TOP_UP);

  // The server is the authority on what is stored: an auto top-up that fired
  // while the tab was open, or a refetch after a checkout, has to be able to
  // correct the form. Keyed on the stored values rather than on the object
  // identity, which Apollo is free to change without the settings changing.
  const stored = React.useRef(settingsKey(balance));
  const key = settingsKey(balance);
  if (stored.current !== key) {
    stored.current = key;
    setValues(formValuesOf(balance));
    setErrors({});
  }

  // Keyed on what the server stores, not on the form: a workspace whose provider
  // stopped supporting saved cards has to be able to turn an existing automatic
  // top-up *off*, and a form-keyed lock would disable Save the moment it did.
  const locked = !canSpend || (!balance.autoTopUp.available && !balance.autoTopUp.enabled);
  const set = (patch: Partial<AutoTopUpFormValues>) => setValues((current) => ({ ...current, ...patch }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    const found = validateAutoTopUp(values, balance.minTopUpMicros);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    try {
      await setAutoTopUp({
        variables: { input: { workspaceId, settings: toAutoTopUpInput(values) } },
        // `CreditBalance` has no `id`, so Apollo cannot normalise it and the
        // mutation's result would sit in `ROOT_MUTATION` while the screen kept
        // reading the stale balance. Write it where the screen looks.
        update: (cache, { data }) => {
          const updated = data?.setAutoTopUp;
          if (!updated) return;
          cache.updateQuery(
            { query: CREDITS_QUERY, variables: { workspaceId, first: CREDITS_PAGE_SIZE } },
            (existing) => (existing ? { ...existing, creditBalance: updated } : existing),
          );
        },
      });
      toast.success(values.enabled ? 'Automatic top-up updated.' : 'Automatic top-up turned off.');
    } catch (cause) {
      toast.error(errorMessageOf(cause, 'The automatic top-up settings could not be saved.'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Auto top-up</CardTitle>
        <CardDescription>
          Buy credits automatically when the balance drops below a threshold, using the card saved by your last
          checkout.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="auto-top-up-enabled" className="font-normal">
              Enable automatic top-up
            </Label>
            <Switch
              id="auto-top-up-enabled"
              checked={values.enabled}
              disabled={locked}
              onCheckedChange={(checked) => set({ enabled: checked })}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="auto-top-up-threshold">When balance falls below (USD)</Label>
              <Input
                id="auto-top-up-threshold"
                inputMode="decimal"
                value={values.threshold}
                disabled={locked || !values.enabled}
                onChange={(event) => set({ threshold: event.target.value })}
                placeholder="20"
                aria-invalid={errors.threshold !== undefined || undefined}
                aria-describedby={errors.threshold ? 'auto-top-up-threshold-error' : undefined}
              />
              {errors.threshold ? (
                <p id="auto-top-up-threshold-error" className="text-destructive text-xs">
                  {errors.threshold}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="auto-top-up-amount">Buy this much (USD)</Label>
              <Input
                id="auto-top-up-amount"
                inputMode="decimal"
                value={values.amount}
                disabled={locked || !values.enabled}
                onChange={(event) => set({ amount: event.target.value })}
                placeholder={microsToUsdInput(balance.minTopUpMicros)}
                aria-invalid={errors.amount !== undefined || undefined}
                aria-describedby={errors.amount ? 'auto-top-up-amount-error' : undefined}
              />
              {errors.amount ? (
                <p id="auto-top-up-amount-error" className="text-destructive text-xs">
                  {errors.amount}
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs">
              {balance.autoTopUp.available
                ? `Minimum ${formatUsd(balance.minTopUpMicros)} per charge.`
                : 'The configured payment provider cannot charge a saved card, so automatic top-up is unavailable.'}
              {balance.autoTopUp.lastChargedAt ? ` Last charged ${formatDate(balance.autoTopUp.lastChargedAt)}.` : null}
            </p>
            <Button type="submit" variant="outline" disabled={locked || loading}>
              {loading ? 'Saving…' : 'Save'}
            </Button>
          </div>
          {canSpend ? null : (
            <p className="text-muted-foreground text-xs">Only a workspace owner can change these settings.</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
