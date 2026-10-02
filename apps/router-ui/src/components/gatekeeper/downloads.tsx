import { Badge } from '@confidential-router/ui/components/badge';
import { Button } from '@confidential-router/ui/components/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@confidential-router/ui/components/table';
import { Download, ExternalLink, FileCheck2 } from 'lucide-react';
import type { GatekeeperArch, GatekeeperOs, GatekeeperReleaseQuery } from '../../generated/graphql';
import { formatBytes, formatDate } from '../../lib/format';

type Release = NonNullable<GatekeeperReleaseQuery['gatekeeperRelease']>;

const OS_LABELS: Record<GatekeeperOs, string> = {
  LINUX: 'Linux',
  MACOS: 'macOS',
  WINDOWS: 'Windows',
};

/** `amd64` is what the asset is called; `x86-64` is what people search for. */
const ARCH_LABELS: Record<GatekeeperArch, string> = {
  AMD64: 'x86-64 (amd64)',
  ARM64: 'arm64',
};

export function DownloadTable({ release }: { release: Release }) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Platform</TableHead>
            <TableHead>Architecture</TableHead>
            <TableHead>File</TableHead>
            <TableHead className="text-right">Size</TableHead>
            <TableHead className="w-10">
              <span className="sr-only">Download</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {release.downloads.map((download) => (
            <TableRow key={download.name}>
              <TableCell className="font-medium">{OS_LABELS[download.os]}</TableCell>
              <TableCell>{ARCH_LABELS[download.arch]}</TableCell>
              <TableCell className="font-mono text-muted-foreground text-xs">{download.name}</TableCell>
              <TableCell className="text-right text-muted-foreground text-xs">
                {formatBytes(download.sizeBytes)}
              </TableCell>
              <TableCell>
                <Button asChild variant="outline" size="sm">
                  <a href={download.url} download>
                    <Download aria-hidden="true" />
                    <span className="sr-only sm:not-sr-only">Download</span>
                    <span className="sr-only">
                      {OS_LABELS[download.os]} {ARCH_LABELS[download.arch]}
                    </span>
                  </a>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function ReleaseMeta({ release }: { release: Release }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <Badge variant="secondary" className="font-mono">
        {release.version}
      </Badge>
      {release.publishedAt ? (
        <span className="text-muted-foreground text-xs">Published {formatDate(release.publishedAt)}</span>
      ) : null}
      {release.stale ? (
        <Badge variant="warning" title={`Last read ${formatDate(release.fetchedAt)}`}>
          Last known links
        </Badge>
      ) : null}
      <a
        className="inline-flex items-center gap-1 text-brand-emphasis text-xs underline underline-offset-4"
        href={release.notesUrl}
        target="_blank"
        rel="noreferrer noopener"
      >
        Release notes
        <ExternalLink className="size-3" aria-hidden="true" />
      </a>
      {release.checksumsUrl ? (
        <a
          className="inline-flex items-center gap-1 text-brand-emphasis text-xs underline underline-offset-4"
          href={release.checksumsUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          <FileCheck2 className="size-3" aria-hidden="true" />
          Checksums
        </a>
      ) : null}
    </div>
  );
}

/**
 * Desktop and Docker are in the design and are not built yet (ADR "Distribution":
 * GitHub Releases only for now). They are named rather than hidden so nobody has
 * to guess whether they are coming.
 */
export function ComingLater() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {[
        {
          title: 'Gatekeeper Desktop',
          detail: 'A tray app that runs the same verifier and shows live verdicts.',
        },
        {
          title: 'Docker image',
          detail: 'A sidecar next to your service, with the same config surface.',
        },
      ].map((item) => (
        <div key={item.title} className="rounded-lg border border-dashed p-4">
          <div className="mb-1 flex items-center gap-2">
            <p className="font-medium text-sm">{item.title}</p>
            <Badge variant="outline">Coming later</Badge>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">{item.detail}</p>
        </div>
      ))}
    </div>
  );
}
