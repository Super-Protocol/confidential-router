import { Badge } from '@confidential-router/ui/components/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@confidential-router/ui/components/table';
import type { GenerationStatus } from '../../generated/graphql';
import { formatUsd } from '../../lib/format';
import { formatExact, formatMs, formatTokensPerSecond } from '../../lib/metrics';
import { STATUS_LABELS } from './filters';

export interface GenerationRow {
  id: string;
  createdAt: string;
  modelName: string;
  apiKeyName: string | null;
  promptTokens: number;
  completionTokens: number;
  costMicros: string;
  latencyMs: number;
  timeToFirstTokenMs: number | null;
  tokensPerSecond: number | null;
  status: GenerationStatus;
  errorCode: string | null;
}

export interface GenerationTableProps {
  rows: GenerationRow[];
}

const STATUS_VARIANTS: Record<GenerationStatus, 'success' | 'destructive' | 'warning'> = {
  OK: 'success',
  ERROR: 'destructive',
  ABORTED: 'warning',
};

const TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/**
 * One metered generation per row — never any prompt or completion content;
 * there is none stored to render (ADR-002, `Generation` in the schema).
 *
 * No evidence column: what an endpoint published is a fact about the endpoint,
 * and the Models screen is where it belongs. A digest per log line would read as
 * a per-request verdict, which the router by design never has.
 */
export function GenerationTable({ rows }: GenerationTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>API key</TableHead>
          <TableHead className="text-right">Input</TableHead>
          <TableHead className="text-right">Output</TableHead>
          <TableHead className="text-right">Cost</TableHead>
          <TableHead className="text-right">Speed</TableHead>
          <TableHead className="text-right">TTFT</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-mono text-muted-foreground text-xs">
              <time dateTime={row.createdAt}>{TIME.format(new Date(row.createdAt))}</time>
            </TableCell>
            <TableCell className="max-w-[16rem] truncate font-medium">{row.modelName}</TableCell>
            <TableCell className="max-w-[10rem] truncate text-muted-foreground">
              {row.apiKeyName ?? 'deleted key'}
            </TableCell>
            <TableCell className="text-right font-mono">{formatExact(row.promptTokens)}</TableCell>
            <TableCell className="text-right font-mono">{formatExact(row.completionTokens)}</TableCell>
            <TableCell className="text-right font-mono">
              {formatUsd(row.costMicros, { maximumFractionDigits: 4 })}
            </TableCell>
            <TableCell className="text-right font-mono">{formatTokensPerSecond(row.tokensPerSecond)}</TableCell>
            <TableCell className="text-right font-mono">{formatMs(row.timeToFirstTokenMs)}</TableCell>
            <TableCell>
              <Badge variant={STATUS_VARIANTS[row.status]}>
                {row.status === 'ERROR' && row.errorCode ? row.errorCode : STATUS_LABELS[row.status]}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
