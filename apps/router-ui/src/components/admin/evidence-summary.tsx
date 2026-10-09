import { Boxes, Container } from 'lucide-react';
import type { ExternalEndpointEvidenceFieldsFragment } from '../../generated/graphql';
import { formatTimestamp } from '../../lib/format';
import { DigestValue } from '../evidence/digest-value';
import { InfoPopover } from '../info-popover';

export interface EvidenceSummaryProps {
  evidence: ExternalEndpointEvidenceFieldsFragment;
  /** Distinguishes the standing summary from the one attached to a timeline entry. */
  heading?: string;
  /** Headless variant for the timeline, where the card chrome would nest. */
  bare?: boolean;
}

/**
 * What a cloud-level admission actually let in: the upstream's workloads and the
 * image digests they run.
 *
 * SUP-221 ruling 1 made this non-optional, and SUP-252 made it the basis of a
 * decision: admission now also requires the deployment's evidence digest to be
 * the one an admin pinned, and this summary is what that digest stands for. It is
 * shown at registration and on every change, so the admin approving a digest has
 * read what it lets in.
 */
export function EvidenceSummary({ evidence, heading = 'Evidence summary', bare = false }: EvidenceSummaryProps) {
  const images = evidence.containerImages;
  const workloads = evidence.workloads;

  return (
    <section
      aria-label={heading}
      className={bare ? 'space-y-3' : 'space-y-3 rounded-lg border bg-muted/30 p-4'}
      data-testid="evidence-summary"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h4 className="font-medium text-sm">{heading}</h4>
          <InfoPopover label="What this summary is for">
            <p>
              What this snapshot digest stands for. The digest is what an admin pins as the deployment trust factor, so
              this is what a pin approves — read it before approving.
            </p>
          </InfoPopover>
        </div>
        <p className="text-muted-foreground text-xs">
          Published {formatTimestamp(evidence.issuedAt)} · seen {formatTimestamp(evidence.fetchedAt)}
          {evidence.quoteFormat ? ` · ${evidence.quoteFormat}` : ''}
        </p>
      </div>

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Snapshot digest</dt>
        <dd className="font-mono text-xs">
          <DigestValue
            hex={evidence.evidenceDigestHex}
            canonical={evidence.evidenceDigest}
            copyLabel="Copy the upstream’s evidence digest"
          />
        </dd>

        <dt className="text-muted-foreground">Pinned certificate</dt>
        <dd className="font-mono text-xs">
          <DigestValue hex={evidence.certFingerprintHex} canonical={evidence.certFingerprint} />
        </dd>
      </dl>

      <div className="space-y-2">
        <h5 className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          <Boxes className="size-3.5" aria-hidden="true" />
          Workloads ({workloads.length})
        </h5>
        {workloads.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            The upstream’s snapshot declares no Kubernetes workloads this console can read.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {workloads.map((workload) => (
              <li key={`${workload.kind}/${workload.namespace ?? ''}/${workload.name}`} className="text-sm">
                <span className="font-mono text-xs">
                  {workload.kind}/{workload.name}
                </span>
                {workload.namespace ? (
                  <span className="text-muted-foreground text-xs"> · {workload.namespace}</span>
                ) : null}
                {workload.containers.length > 0 ? (
                  <span className="text-muted-foreground text-xs"> · {workload.containers.join(', ')}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h5 className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          <Container className="size-3.5" aria-hidden="true" />
          Image digests ({images.length})
        </h5>
        {images.length === 0 ? (
          <p className="text-muted-foreground text-xs">The upstream’s snapshot names no container images.</p>
        ) : (
          <ul className="space-y-1">
            {images.map((image) => (
              <li key={image} className="break-all font-mono text-xs">
                {image}
              </li>
            ))}
          </ul>
        )}
      </div>

      {evidence.measurements.length > 0 ? (
        <div className="space-y-2">
          <h5 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Measurements</h5>
          <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
            {evidence.measurements.map((measurement) => (
              <div key={measurement.name} className="contents">
                <dt className="text-muted-foreground text-xs">{measurement.name}</dt>
                <dd className="break-all font-mono text-xs">{measurement.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </section>
  );
}
