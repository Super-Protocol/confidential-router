'use client';

import { Badge } from '@confidential-router/ui/components/badge';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { BarChart } from '@confidential-router/ui/components/charts/bar-chart';
import { Heatmap } from '@confidential-router/ui/components/charts/heatmap';
import { Sparkline } from '@confidential-router/ui/components/charts/sparkline';
import { StackedBarChart } from '@confidential-router/ui/components/charts/stacked-bar-chart';
import { CopyButton } from '@confidential-router/ui/components/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@confidential-router/ui/components/dialog';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@confidential-router/ui/components/select';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { Switch } from '@confidential-router/ui/components/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@confidential-router/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@confidential-router/ui/components/tabs';
import { Inbox } from 'lucide-react';
import type * as React from 'react';
import { toast } from 'sonner';
import { PageHeader } from '../../../components/page-header';
import { ThemeToggle } from '../../../components/theme-toggle';

const BARS = [12, 28, 64, 55, 39, 0, 0].map((value, index) => ({
  label: `Day ${index + 1}`,
  value,
}));

const STACKED_SERIES = [
  { key: 'output', label: 'Output tokens' },
  { key: 'input', label: 'Input tokens' },
];

const STACKED_BARS = [4200, 5100, 6800, 5900, 0, 7400, 8100].map((input, index) => ({
  id: `day-${index}`,
  label: `${index + 1} Aug`,
  values: { input, output: Math.round(input * 0.3) },
}));

const HEATMAP_CELLS = Array.from({ length: 7 * 22 }, (_, index) => ({
  date: new Date(Date.UTC(2026, 2, 1 + index)).toISOString().slice(0, 10),
  value: index < 126 ? 0 : (index * 7) % 5,
}));

const ROWS = [
  { host: 'router-eu.example.com', tee: 'Intel TDX', state: 'PUBLISHED' as const, tokens: '312.4M' },
  { host: 'router-us.example.com', tee: 'Intel TDX + H100', state: 'STALE' as const, tokens: '188.1M' },
  { host: 'router-ap.example.com', tee: 'AMD SEV-SNP', state: 'NOT_PUBLISHED' as const, tokens: '0' },
];

const STATE_VARIANT = {
  PUBLISHED: 'success',
  STALE: 'warning',
  NOT_PUBLISHED: 'outline',
} as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm uppercase tracking-wide">{title}</h2>
      {children}
    </section>
  );
}

export function ComponentGallery() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <PageHeader
        title="Components"
        description="Every primitive in @confidential-router/ui. Switch theme and accent to review both modes and all four accents."
        actions={<ThemeToggle />}
      />

      <div className="space-y-10">
        <Section title="Buttons">
          <div className="flex flex-wrap gap-2">
            {(['default', 'brand', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const).map((variant) => (
              <Button key={variant} variant={variant}>
                {variant}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(['sm', 'default', 'lg'] as const).map((size) => (
              <Button key={size} size={size} variant="outline">
                size {size}
              </Button>
            ))}
            <Button disabled>disabled</Button>
          </div>
        </Section>

        <Section title="Badges">
          <div className="flex flex-wrap gap-2">
            {(['default', 'brand', 'secondary', 'outline', 'success', 'warning', 'destructive'] as const).map(
              (variant) => (
                <Badge key={variant} variant={variant}>
                  {variant}
                </Badge>
              ),
            )}
          </div>
        </Section>

        <Section title="Card">
          <div className="grid gap-3.5 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardDescription>Spend</CardDescription>
                <CardTitle className="font-mono text-2xl">$149.34</CardTitle>
              </CardHeader>
              <CardContent>
                <BarChart data={BARS} label="Spend per day, last 7 days" height={56} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Evidence coverage</CardDescription>
                <CardTitle className="font-mono text-2xl text-success">100%</CardTitle>
              </CardHeader>
              <CardContent className="text-muted-foreground text-sm">
                Every generation this week returned a signed quote alongside the completion.
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section title="Charts">
          <div className="space-y-5 rounded-lg border p-4">
            <div className="flex flex-wrap items-start gap-8">
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs">Sparkline</p>
                <Sparkline values={[19, 19, 18, 16, 3, 17, 19, 19]} label="Latency trend" />
              </div>
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs">Sparkline (flat)</p>
                <Sparkline values={[5, 5, 5, 5, 5]} label="Flat trend" className="text-success" />
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-muted-foreground text-xs">Stacked bar chart</p>
              <StackedBarChart
                data={STACKED_BARS}
                series={STACKED_SERIES}
                label="Tokens per day, last 7 days"
                height={120}
                axis="all"
                format={(value) => `${value} tok`}
              />
            </div>
            <div className="space-y-2">
              <p className="text-muted-foreground text-xs">Heatmap</p>
              {/* The tiles are square, so the grid's width sets their size. */}
              <Heatmap cells={HEATMAP_CELLS} label="Days with signed responses" className="max-w-80" />
            </div>
          </div>
        </Section>

        <Section title="Table">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>TEE</TableHead>
                  <TableHead>Evidence</TableHead>
                  <TableHead className="text-right">Tokens 30d</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ROWS.map((row) => (
                  <TableRow key={row.host}>
                    <TableCell className="font-mono text-xs">{row.host}</TableCell>
                    <TableCell>{row.tee}</TableCell>
                    <TableCell>
                      <Badge variant={STATE_VARIANT[row.state]}>{row.state.replace('_', ' ').toLowerCase()}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">{row.tokens}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>

        <Section title="Forms">
          <div className="grid max-w-md gap-3">
            <div className="grid gap-2">
              <Label htmlFor="gallery-email">Email</Label>
              <Input id="gallery-email" type="email" placeholder="you@example.com" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="gallery-window">Window</Label>
              <Select defaultValue="7d">
                <SelectTrigger id="gallery-window">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="24h">Last 24 hours</SelectItem>
                  <SelectItem value="7d">Last 7 days</SelectItem>
                  <SelectItem value="30d">Last 30 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="gallery-archive">Archive quotes</Label>
              <Switch id="gallery-archive" defaultChecked />
            </div>
          </div>
        </Section>

        <Section title="Tabs, dialog, toast">
          <Tabs defaultValue="chain" className="max-w-md">
            <TabsList>
              <TabsTrigger value="chain">Chain</TabsTrigger>
              <TabsTrigger value="measurements">Measurements</TabsTrigger>
            </TabsList>
            <TabsContent value="chain" className="pt-3 text-muted-foreground text-sm">
              Leaf → intermediate → root, each pinned by SHA-256 fingerprint.
            </TabsContent>
            <TabsContent value="measurements" className="pt-3 text-muted-foreground text-sm">
              MRTD and RTMR values as published in the evidence bundle.
            </TabsContent>
          </Tabs>
          <div className="flex flex-wrap gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Open dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Evidence report</DialogTitle>
                  <DialogDescription>
                    The published bundle for this endpoint. The router never records whether it was verified.
                  </DialogDescription>
                </DialogHeader>
              </DialogContent>
            </Dialog>
            <Button variant="outline" onClick={() => toast.success('Evidence JWS copied')}>
              Show toast
            </Button>
            <CopyButton
              value="sha256:f579367d3d6942f03b05d138acbd1e426dd7913a59f2f35cd58b16b87809a00b"
              label="Copy the evidence digest"
              variant="outline"
              showLabel
            />
            <CopyButton
              value="sha256:f579367d3d6942f03b05d138acbd1e426dd7913a59f2f35cd58b16b87809a00b"
              label="Copy the evidence digest"
            />
          </div>
        </Section>

        <Section title="States">
          <div className="grid gap-3.5 lg:grid-cols-2">
            <EmptyState
              icon={<Inbox className="size-5" aria-hidden="true" />}
              title="No API keys yet"
              description="Create a key to start routing requests."
              action={
                <Button size="sm" variant="brand">
                  Create key
                </Button>
              }
            />
            <ErrorState detail="operation Session" onRetry={() => toast.info('Retried')} />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-24 w-full" />
          </div>
        </Section>
      </div>
    </div>
  );
}
