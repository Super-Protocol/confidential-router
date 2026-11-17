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
import { readCoverage } from '../../lib/evidence-coverage';
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
  coveredRequests: number;
  coverableRequests: number;
  evidenceCoverage: number | null;
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

  const rows = models.map((model) => ({ model, coverage: readCoverage(model) }));

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
                {rows.map(({ model, coverage }) => (
                  <TableRow key={model.modelId}>
                    <TableCell className="max-w-[18rem] truncate font-medium">{model.name}</TableCell>
                    <TableCell className="text-right font-mono">{formatCount(model.requests)}</TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCount(model.promptTokens + model.completionTokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono">{formatUsd(model.spendMicros)}</TableCell>
                    {/*
                      An external model has no coverable request, so it has no
                      ratio — an em dash with the reason on hover, never the
                      `0%` that reads as "nothing about this model was proved"
                      (SUP-421).
                    */}
                    <TableCell className="text-right font-mono">
                      {coverage.ratio === null ? (
                        <span className="text-muted-foreground" title={coverage.detail}>
                          —
                        </span>
                      ) : (
                        formatRatio(coverage.ratio)
                      )}
                    </TableCell>
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
