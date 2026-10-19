'use client';

import { useMutation } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@confidential-router/ui/components/select';
import * as React from 'react';
import { formatUsd, formatUsdShort, usdToMicros } from '../../../lib/format';
import { errorMessageOf } from '../../../lib/graphql-error';
import {
  type CreditMovement,
  type GrantCreditErrors,
  type GrantCreditForm,
  kindOf,
  MOVEMENT_HELP,
  MOVEMENT_LABEL,
  signOf,
  validateGrantForm,
} from './invitations';
import { GRANT_CREDIT } from './operations';

const MOVEMENTS: CreditMovement[] = ['GRANT', 'ADJUSTMENT_ADD', 'ADJUSTMENT_REMOVE'];

const INITIAL: GrantCreditForm = { amount: '100', movement: 'GRANT', note: '' };

export interface GrantCreditTarget {
  email: string;
  workspaceId: string;
  balanceMicros: string | null;
}

/**
 * Putting credit on an account that already exists (SUP-406).
 *
 * On the accounts list and not on the Credits screen, because the Credits screen
 * is the *account holder's*: an operator topping up a tester has no session as
 * that tester, and before this the honest answer to "can you add $50 to their
 * balance" was no. The target is the workspace id the list already has, so the
 * dialog never has to re-resolve an address it is looking at.
 *
 * Three movements rather than a signed amount, so what the ledger records is
 * what the operator picked: a `GRANT` is new credit, and a correction is an
 * `ADJUSTMENT` either way. Removing credit is the one the deployment has to have
 * allowed (`billing.allowCreditDebits`); the console cannot read that setting,
 * so the API's refusal — which names the key — is what says so.
 */
export function GrantCreditDialog({
  target,
  onOpenChange,
  onGranted,
}: {
  target: GrantCreditTarget | null;
  onOpenChange: (open: boolean) => void;
  /** Re-reads the list behind the dialog, so the balance column shows the entry just written. */
  onGranted?: () => void;
}) {
  const [form, setForm] = React.useState<GrantCreditForm>(INITIAL);
  const [errors, setErrors] = React.useState<GrantCreditErrors>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<{ amountMicros: string; balanceMicros: string } | null>(null);

  const [grant, { loading }] = useMutation(GRANT_CREDIT);
  /**
   * In flight, tracked outside React state.
   *
   * `loading` only flips on the next render, so two clicks inside one render
   * window both pass a check on it — and this is the one mutation where that
   * writes a second ledger entry: `CreditGrantService` keys each call freshly on
   * purpose (an operator asking twice means twice) and says this dialog is what
   * stops a double-click. A ref is what makes that true.
   */
  const inFlight = React.useRef(false);

  const reset = () => {
    setForm(INITIAL);
    setErrors({});
    setFailure(null);
    setDone(null);
  };

  /** Every way out of the dialog, so none of them can leave state behind. */
  const close = () => {
    reset();
    onOpenChange(false);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!target || inFlight.current) return;
    setFailure(null);

    const found = validateGrantForm(form, target.balanceMicros);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const micros = usdToMicros(form.amount) as string;
    const amountMicros = `${signOf(form.movement) === -1 ? '-' : ''}${micros}`;
    inFlight.current = true;
    try {
      const result = await grant({
        variables: {
          input: {
            workspaceId: target.workspaceId,
            kind: kindOf(form.movement),
            amountMicros,
            note: form.note.trim() === '' ? null : form.note.trim(),
          },
        },
      });
      const credited = result.data?.grantCredit;
      if (credited) {
        setDone({ amountMicros: credited.amountMicros, balanceMicros: credited.balanceMicros });
        onGranted?.();
      }
    } catch (caught) {
      setFailure(errorMessageOf(caught));
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (next) return;
        close();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {done ? (
          <>
            <DialogHeader>
              <DialogTitle>{BigInt(done.amountMicros) < 0n ? 'Credit removed' : 'Credit added'}</DialogTitle>
              <DialogDescription data-testid="grant-credit-done">
                {formatUsdShort(done.amountMicros.replace('-', ''))}{' '}
                {BigInt(done.amountMicros) < 0n ? 'taken from' : 'added to'} {target?.email}. Their balance is now{' '}
                {formatUsd(done.balanceMicros)}. The ledger entry names you as the operator.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="brand" onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Credit {target?.email}</DialogTitle>
              <DialogDescription>
                {target?.balanceMicros === null
                  ? 'This account has no workspace yet.'
                  : `They hold ${formatUsd(target?.balanceMicros ?? '0')} today.`}{' '}
                One ledger entry is written, naming you and your note — there is no undo other than a correction.
              </DialogDescription>
            </DialogHeader>

            <form id="grant-credit-form" className="grid gap-4" onSubmit={(event) => void submit(event)}>
              <div className="grid gap-1.5">
                <Label htmlFor="grant-movement">Movement</Label>
                <Select
                  value={form.movement}
                  onValueChange={(value) => {
                    setForm((current) => ({ ...current, movement: value as CreditMovement }));
                    setErrors({});
                  }}
                  disabled={loading}
                >
                  <SelectTrigger id="grant-movement">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MOVEMENTS.map((movement) => (
                      <SelectItem key={movement} value={movement}>
                        {MOVEMENT_LABEL[movement]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">{MOVEMENT_HELP[form.movement]}</p>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="grant-amount">Amount (USD)</Label>
                <Input
                  id="grant-amount"
                  value={form.amount}
                  onChange={(event) => {
                    setForm((current) => ({ ...current, amount: event.target.value }));
                    setErrors((current) => ({ ...current, amount: undefined }));
                  }}
                  inputMode="decimal"
                  autoComplete="off"
                  disabled={loading}
                  aria-invalid={Boolean(errors.amount)}
                  aria-describedby={errors.amount ? 'grant-amount-error' : undefined}
                />
                {errors.amount ? (
                  <p id="grant-amount-error" role="alert" className="text-destructive text-xs">
                    {errors.amount}
                  </p>
                ) : null}
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="grant-note">Note{form.movement === 'ADJUSTMENT_REMOVE' ? '' : ' (optional)'}</Label>
                <Input
                  id="grant-note"
                  value={form.note}
                  onChange={(event) => {
                    setForm((current) => ({ ...current, note: event.target.value }));
                    setErrors((current) => ({ ...current, note: undefined }));
                  }}
                  placeholder="Why this balance is changing"
                  maxLength={400}
                  autoComplete="off"
                  disabled={loading}
                  aria-invalid={Boolean(errors.note)}
                  aria-describedby={errors.note ? 'grant-note-error' : 'grant-note-help'}
                />
                {errors.note ? (
                  <p id="grant-note-error" role="alert" className="text-destructive text-xs">
                    {errors.note}
                  </p>
                ) : (
                  <p id="grant-note-help" className="text-muted-foreground text-xs">
                    Kept on the ledger row, and shown to the account holder on their Credits screen.
                  </p>
                )}
              </div>

              {failure ? (
                <p role="alert" className="text-destructive text-sm">
                  {failure}
                </p>
              ) : null}
            </form>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={close} disabled={loading}>
                Cancel
              </Button>
              <Button type="submit" form="grant-credit-form" variant="brand" disabled={loading}>
                {loading ? 'Recording…' : MOVEMENT_LABEL[form.movement]}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
