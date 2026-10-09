'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { StackedBarChart } from '@confidential-router/ui/components/charts/stacked-bar-chart';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@confidential-router/ui/components/table';
import { cn } from '@confidential-router/ui/lib/utils';
import { ChartColumn } from 'lucide-react';
import type { InviteStatisticsQuery } from '../../../generated/graphql';
import { formatUsdShort } from '../../../lib/format';
import { formatCount, formatRatio } from '../../../lib/metrics';
import { StatTile, StatTileSkeleton } from '../../activity/stat-tile';

type Statistics = InviteStatisticsQuery['inviteStatistics'];

export const WINDOWS = [7, 30, 90] as const;
export type WindowDays = (typeof WINDOWS)[number];

const SIGN_UP_SERIES = [
  { key: 'invited', label: 'Invitation' },
  { key: 'bootstrap', label: 'Bootstrap' },
  { key: 'open', label: 'Open sign-up' },
];

const CAMPAIGN_SERIES = [
  { key: 'redeemed', label: 'Redeemed' },
  { key: 'unredeemed', label: 'Not redeemed' },
];

const TILES = ['Codes issued', 'Redeemed', 'Redemption rate', 'Credit granted', 'Accounts'];

/** `2026-10-09` → `9 Oct`, the console's chart axis shape. UTC, as the buckets are. */
function dayLabel(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

/** The 7d / 30d / 90d toggle — the same control Activity uses, over days. */
export function WindowPicker({ value, onChange }: { value: WindowDays; onChange: (days: WindowDays) => void }) {
  return (
    <fieldset
      aria-label="Statistics window"
      className="inline-flex min-w-0 items-center gap-[3px] rounded-lg bg-muted p-[3px]"
    >
      {WINDOWS.map((days) => (
        <button
          key={days}
          type="button"
          aria-pressed={days === value}
          aria-label={`Past ${days} days`}
          onClick={() => onChange(days)}
          className={cn(
            'rounded-md px-2.5 py-1 font-medium text-sm transition-[color,background-color,box-shadow] focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1',
            days === value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground dark:hover:bg-input/30',
          )}
        >
          {days}d
        </button>
      ))}
    </fieldset>
  );
}

/**
 * The three chart groups the section is asked for (SUP-268): sign-ups over time
 * by origin, codes issued against codes redeemed, and the per-campaign
 * breakdown — all from router-api's own tables, which is the source of truth;
 * the funnel analytics stay in PostHog.
 *
 * Issued and redeemed are two charts rather than one stack: a stack would add
 * them, and "issued plus redeemed" is not a quantity.
 */
export function InviteStatsTab({ statistics, days }: { statistics: Statistics | undefined; days: WindowDays }) {
  if (!statistics) {
    return (
      <>
        <div className="mb-6 grid gap-3.5 sm:grid-cols-2 xl:grid-cols-5">
          {TILES.map((label) => (
            <StatTileSkeleton key={label} label={label} />
          ))}
        </div>
        <Skeleton className="mb-6 h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </>
    );
  }

  const { totals, daily, campaigns } = statistics;
  const window = `Past ${days} days`;
  const sum = (pick: (day: Statistics['daily'][number]) => number) =>
    daily.reduce((total, day) => total + pick(day), 0);

  const signUps = daily.map((day) => ({
    id: day.date,
    label: dayLabel(day.date),
    values: { invited: day.signUpsInvited, bootstrap: day.signUpsBootstrap, open: day.signUpsOpen },
  }));
  const issued = daily.map((day) => ({ id: day.date, label: dayLabel(day.date), values: { issued: day.codesIssued } }));
  const redeemed = daily.map((day) => ({
    id: day.date,
    label: dayLabel(day.date),
    values: { redeemed: day.codesRedeemed },
  }));
  const byCampaign = campaigns.map((entry) => ({
    id: entry.campaign,
    label: entry.campaign,
    values: { redeemed: entry.redeemed, unredeemed: Math.max(entry.issued - entry.redeemed, 0) },
  }));

  return (
    <>
      <div className="mb-6 grid gap-3.5 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile
          label="Codes issued"
          value={formatCount(totals.issued)}
          hint={`${formatCount(totals.withdrawn)} withdrawn`}
          series={daily.map((day) => day.codesIssued)}
        />
        <StatTile
          label="Redeemed"
          value={formatCount(totals.redeemed)}
          hint="Accounts created with a code"
          series={daily.map((day) => day.codesRedeemed)}
          accent="brand"
        />
        <StatTile
          label="Redemption rate"
          value={formatRatio(totals.redemptionRate)}
          hint="Redeemed of issued, all time"
          accent="success"
        />
        <StatTile label="Credit granted" value={formatUsdShort(totals.grantedMicros)} hint="Through invitations" />
        <StatTile
          label="Accounts"
          value={formatCount(totals.signUps)}
          hint={`${formatCount(sum((day) => day.signUpsInvited + day.signUpsBootstrap + day.signUpsOpen))} in the window`}
          series={daily.map((day) => day.signUpsInvited + day.signUpsBootstrap + day.signUpsOpen)}
        />
      </div>

      <Card className="mb-6">
        <CardHeader className="border-b pb-4">
          <CardTitle className="text-sm">Sign-ups per day, by origin</CardTitle>
          <CardDescription>{window}, UTC days.</CardDescription>
        </CardHeader>
        <CardContent>
          <StackedBarChart
            data={signUps}
            series={SIGN_UP_SERIES}
            label={`Sign-ups per day by origin, ${window.toLowerCase()}`}
            format={formatCount}
            axis="sparse"
            data-testid="chart-sign-ups"
          />
        </CardContent>
      </Card>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="border-b pb-4">
            <CardTitle className="text-sm">Codes issued per day</CardTitle>
            <CardDescription>
              {formatCount(sum((day) => day.codesIssued))} in the {window.toLowerCase()}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StackedBarChart
              data={issued}
              series={[{ key: 'issued', label: 'Issued', color: 'var(--color-chart-3)' }]}
              label={`Codes issued per day, ${window.toLowerCase()}`}
              format={formatCount}
              legend={false}
              axis="sparse"
              data-testid="chart-issued"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="border-b pb-4">
            <CardTitle className="text-sm">Codes redeemed per day</CardTitle>
            <CardDescription>
              {formatCount(sum((day) => day.codesRedeemed))} in the {window.toLowerCase()}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StackedBarChart
              data={redeemed}
              series={[{ key: 'redeemed', label: 'Redeemed' }]}
              label={`Codes redeemed per day, ${window.toLowerCase()}`}
              format={formatCount}
              legend={false}
              axis="sparse"
              data-testid="chart-redeemed"
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="border-b pb-4">
          <CardTitle className="text-sm">By campaign</CardTitle>
          <CardDescription>All time. Activated means the account went on to send a request.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {campaigns.length === 0 ? (
            <EmptyState
              className="border-0 py-6"
              icon={<ChartColumn className="size-5" aria-hidden="true" />}
              title="No campaigns yet"
              description="Issue codes under a campaign tag and its numbers appear here."
            />
          ) : (
            <>
              <StackedBarChart
                data={byCampaign}
                series={CAMPAIGN_SERIES}
                label="Codes redeemed and not redeemed, by campaign"
                format={formatCount}
                axis="all"
                data-testid="chart-campaigns"
              />
              <Table aria-label="Campaigns">
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead className="text-right">Issued</TableHead>
                    <TableHead className="text-right">Redeemed</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead className="text-right">Activated</TableHead>
                    <TableHead className="text-right">Credit granted</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {campaigns.map((entry) => (
                    <TableRow key={entry.campaign}>
                      <TableCell className="max-w-[18rem] truncate font-mono text-xs">{entry.campaign}</TableCell>
                      <TableCell className="text-right font-mono">{formatCount(entry.issued)}</TableCell>
                      <TableCell className="text-right font-mono">{formatCount(entry.redeemed)}</TableCell>
                      <TableCell className="text-right font-mono">{formatRatio(entry.redemptionRate)}</TableCell>
                      <TableCell className="text-right font-mono">{formatCount(entry.activated)}</TableCell>
                      <TableCell className="text-right font-mono">{formatUsdShort(entry.grantedMicros)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
