import { Badge } from '@confidential-router/ui/components/badge';
import { Button } from '@confidential-router/ui/components/button';
import { CodeBlock } from '@confidential-router/ui/components/code-block';
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
import { INSTALL_COMMANDS, INSTALL_STEPS } from './install-commands';

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

/**
 * The one-liner, first, because it is what almost everyone wants — and the list
 * of what it does, because nobody should paste a `curl | sh` on trust alone.
 * Shown whether or not the release query resolved: the scripts are attached to
 * every release, so the URLs hold even when the console cannot reach GitHub.
 */
export function InstallCommands() {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {INSTALL_COMMANDS.map((entry) => (
          <CodeBlock
            key={entry.platform}
            code={entry.command}
            title={`${entry.platform} · ${entry.shell}`}
            copyLabel={`Copy the ${entry.platform} install command`}
          />
        ))}
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed">
        The script {INSTALL_STEPS.slice(0, -1).join(', ')} and {INSTALL_STEPS[INSTALL_STEPS.length - 1]}. Prefer to do
        it by hand? Take an archive below and check it against the release checksums yourself.
      </p>
    </div>
  );
}

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
