import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { StackedBarChart } from '@confidential-router/ui/components/charts/stacked-bar-chart';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@confidential-router/ui/components/table';
import { BookText } from 'lucide-react';
import { formatUsd } from '../../lib/format';
import { formatCount, formatRatio } from '../../lib/metrics';
import { USAGE_BY_MODEL_DAYS } from '../../lib/ranges';

export interface ModelUsageRow {
  modelId: string;
  name: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  spendMicros: string;
  evidenceCoverage: number;
}

export interface UsageByModelCardProps {
  models: ModelUsageRow[];
}

const SERIES = [
  { key: 'completionTokens', label: 'Output tokens' },
  { key: 'promptTokens', label: 'Input tokens' },
];

/**
 * Token volume per model over a fixed 30-day window, stacked input / output.
 *
 * The window does not follow the range picker: a month is the period the
 * catalogue is judged over, and re-scoping it to the last 24 hours would make
 * the card say something different from its title on every other visit.
 *
 * The stack splits input from output rather than one band per model over time —
 * `activitySeries` has no model dimension (`docs/contracts/console-graphql.md`),
 * and interpolating each model's daily share out of its 30-day total would draw
 * a line the API never returned.
 */
export function UsageByModelCard({ models }: UsageByModelCardProps) {
  const data = models.map((model) => ({
    id: model.modelId,
    label: model.name,
    values: { promptTokens: model.promptTokens, completionTokens: model.completionTokens },
  }));

  return (
    <Card>
      <CardHeader className="border-b pb-4">
        <CardTitle className="text-sm">Usage by model</CardTitle>
        <CardDescription>Last {USAGE_BY_MODEL_DAYS} days, by token volume.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {models.length === 0 ? (
          <EmptyState
            className="border-0 py-6"
            icon={<BookText className="size-5" aria-hidden="true" />}
            title="No model was called in the last 30 days"
            description="Point an OpenAI client at the router and this fills in."
          />
        ) : (
          <>
            <StackedBarChart
              data={data}
              series={SERIES}
              label={`Tokens by model over the last ${USAGE_BY_MODEL_DAYS} days`}
              format={formatCount}
              axis="all"
            />

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Evidence coverage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((model) => (
                  <TableRow key={model.modelId}>
                    <TableCell className="max-w-[18rem] truncate font-medium">{model.name}</TableCell>
                    <TableCell className="text-right font-mono">{formatCount(model.requests)}</TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCount(model.promptTokens + model.completionTokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono">{formatUsd(model.spendMicros)}</TableCell>
                    <TableCell className="text-right font-mono">{formatRatio(model.evidenceCoverage)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
