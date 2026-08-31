import { Card, CardContent } from '@confidential-router/ui/components/card';
import { TriangleAlert } from 'lucide-react';
import { formatUsd } from '../../lib/format';

export interface BalanceCardProps {
  balanceMicros: string;
  /** False once `/v1` starts answering 402 insufficient_credits. */
  spendable: boolean;
}

/**
 * The screen's headline number.
 *
 * A negative balance is shown as it is, not clamped at zero: a generation that
 * overdrew the workspace really did happen, and hiding the overdraft would make
 * the next top-up look like it bought less than it did.
 */
export function BalanceCard({ balanceMicros, spendable }: BalanceCardProps) {
  return (
    <Card>
      <CardContent className="space-y-1">
        <p className="text-muted-foreground text-sm">Total available</p>
        <p className="font-mono font-semibold text-3xl tracking-tight" data-testid="credit-balance">
          {formatUsd(balanceMicros)}
        </p>
        <p className="text-muted-foreground text-sm">
          Pay-as-you-go balance — tokens are metered inside the enclave and charged when the generation returns.
        </p>
        {spendable ? null : (
          <p className="flex items-center gap-2 pt-2 text-destructive text-sm" role="status">
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            Out of credits: <code className="font-mono">/v1</code> is answering 402 until the balance is topped up.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
