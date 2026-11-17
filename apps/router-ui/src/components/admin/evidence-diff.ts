import type { ExternalEndpointEvidenceFieldsFragment } from '../../generated/graphql';

type Workload = ExternalEndpointEvidenceFieldsFragment['workloads'][number];

/** What changed between the deployment an admin approved and the one now answering. */
export interface EvidenceDiff {
  imagesAdded: string[];
  imagesRemoved: string[];
  /** `Kind/name · namespace`, the same spelling the evidence summary uses. */
  workloadsAdded: string[];
  workloadsRemoved: string[];
  /** Workloads present in both whose container list changed. */
  workloadsChanged: string[];
}

export function workloadLabel(workload: Workload): string {
  return `${workload.kind}/${workload.name}${workload.namespace ? ` · ${workload.namespace}` : ''}`;
}

function minus<T>(left: readonly T[], right: readonly T[]): T[] {
  const other = new Set(right);
  return left.filter((value) => !other.has(value));
}

/**
 * The evidence summary diff the "approve new digest" decision is made from
 * (SUP-252).
 *
 * A redeploy changes the evidence digest, and the digest alone says only *that*
 * something changed. What the admin needs before approving is *what*: an image
 * replaced, a workload added beside the model server. Both summaries are the
 * upstream's own publications, filed against the leaf the sidecar observed, so the
 * diff is between two things this router actually saw — never a guess.
 */
export function diffEvidence(
  approved: ExternalEndpointEvidenceFieldsFragment,
  current: ExternalEndpointEvidenceFieldsFragment,
): EvidenceDiff {
  const approvedWorkloads = new Map(approved.workloads.map((workload) => [workloadLabel(workload), workload]));
  const currentWorkloads = new Map(current.workloads.map((workload) => [workloadLabel(workload), workload]));
  const workloadsChanged = [...currentWorkloads.entries()]
    .filter(([label, workload]) => {
      const before = approvedWorkloads.get(label);
      return before !== undefined && before.containers.join('\n') !== workload.containers.join('\n');
    })
    .map(([label]) => label);

  return {
    imagesAdded: minus(current.containerImages, approved.containerImages),
    imagesRemoved: minus(approved.containerImages, current.containerImages),
    workloadsAdded: minus([...currentWorkloads.keys()], [...approvedWorkloads.keys()]),
    workloadsRemoved: minus([...approvedWorkloads.keys()], [...currentWorkloads.keys()]),
    workloadsChanged,
  };
}

export function isEmptyDiff(diff: EvidenceDiff): boolean {
  return Object.values(diff).every((values) => values.length === 0);
}
