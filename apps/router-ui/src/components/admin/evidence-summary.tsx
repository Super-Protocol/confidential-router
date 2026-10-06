import { Boxes, Container, Info } from 'lucide-react';
import type { ExternalEndpointEvidenceFieldsFragment } from '../../generated/graphql';
import { formatTimestamp } from '../../lib/format';
import { DigestValue } from '../evidence/digest-value';

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
 * SUP-221 ruling 1 makes this non-optional, and it is worth saying why in the
 * component rather than only in the issue. Admission here is one check — is the
 * cloud's launch measurement on the admin list (ADR-008 §3) — and that check
 * cannot see *what* was deployed on that cloud (threat T13). So the operator is
 * shown the whole picture at registration and on every change, labelled as
 * informational, because the alternative is an operator who believes a green
 * chip means they looked.
 *
 * Nothing here gates anything, and the copy says so out loud: a reader who
 * thinks this list was approved would be reading per-endpoint approval back into
 * a design that deliberately removed it.
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
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-medium text-sm">{heading}</h4>
        <p className="text-muted-foreground text-xs">
          Published {formatTimestamp(evidence.issuedAt)} · seen {formatTimestamp(evidence.fetchedAt)}
          {evidence.quoteFormat ? ` · ${evidence.quoteFormat}` : ''}
        </p>
      </div>

      <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          Informational, not a gate. Admission is the measurement check alone, which admits a cloud and cannot see which
          deployment on it answered — this is what it let in.
        </span>
      </p>

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
