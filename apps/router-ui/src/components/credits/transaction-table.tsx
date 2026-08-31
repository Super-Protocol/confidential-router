import { Badge } from '@confidential-router/ui/components/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@confidential-router/ui/components/table';
import { ExternalLink } from 'lucide-react';
import type { CreditTransactionKind } from '../../generated/graphql';
import { formatDate, formatUsd } from '../../lib/format';
import { descriptionTextOf, receiptUrlOf } from './amounts';

export interface TransactionRow {
  id: string;
  createdAt: string;
  kind: CreditTransactionKind;
  amountMicros: string;
  reference?: string | null;
  description?: string | null;
}

const KIND_LABELS: Record<CreditTransactionKind, string> = {
  PURCHASE: 'Purchase',
  AUTO_TOPUP: 'Auto top-up',
  USAGE: 'Usage',
  REFUND: 'Refund',
  ADJUSTMENT: 'Adjustment',
};

export function TransactionTable({ transactions }: { transactions: readonly TransactionRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Description</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Receipt</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {transactions.map((entry) => {
          const receipt = receiptUrlOf(entry.description);
          // Signed micro-USD: credits positive, usage negative. The sign is what
          // says which way the money moved, so it is never dropped.
          const credit = !entry.amountMicros.startsWith('-');

          return (
            <TableRow key={entry.id}>
              <TableCell className="whitespace-nowrap">{formatDate(entry.createdAt)}</TableCell>
              <TableCell>
                <Badge variant="outline">{KIND_LABELS[entry.kind]}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {descriptionTextOf(entry.description) || entry.reference || '—'}
              </TableCell>
              <TableCell
                className={`text-right font-mono whitespace-nowrap ${credit ? 'text-brand' : 'text-foreground'}`}
              >
                {credit ? '+' : ''}
                {formatUsd(entry.amountMicros)}
              </TableCell>
              <TableCell className="text-right">
                {receipt ? (
                  <a
                    className="inline-flex items-center gap-1 text-sm underline underline-offset-4"
                    href={receipt}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Receipt
                    <ExternalLink className="size-3" aria-hidden="true" />
                  </a>
                ) : (
                  <span className="text-muted-foreground text-sm">—</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
