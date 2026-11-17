import { describe, expect, it } from 'vitest';
import { EVIDENCE, EVIDENCE_AFTER_CHANGE } from './admin-mocks';
import { diffEvidence, isEmptyDiff } from './evidence-diff';

describe('diffEvidence', () => {
  it('names the image a redeploy replaced, in both directions', () => {
    const diff = diffEvidence(EVIDENCE, EVIDENCE_AFTER_CHANGE);

    expect(diff.imagesAdded).toEqual(EVIDENCE_AFTER_CHANGE.containerImages);
    expect(diff.imagesRemoved).toEqual(EVIDENCE.containerImages);
    expect(diff.workloadsAdded).toEqual([]);
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it('reports a workload added beside the model server, and one whose containers changed', () => {
    const after = {
      ...EVIDENCE,
      workloads: [
        { ...EVIDENCE.workloads[0], containers: ['vllm'] },
        EVIDENCE.workloads[1],
        {
          __typename: 'EvidenceWorkload' as const,
          kind: 'DaemonSet',
          name: 'exfil',
          namespace: null,
          containers: ['x'],
        },
      ],
    };

    const diff = diffEvidence(EVIDENCE, after);

    expect(diff.workloadsAdded).toEqual(['DaemonSet/exfil']);
    expect(diff.workloadsChanged).toEqual(['Deployment/vllm · qwen3-coder']);
    expect(diff.workloadsRemoved).toEqual([]);
  });

  it('is empty when only the signature moved — a re-issue of the same snapshot', () => {
    expect(isEmptyDiff(diffEvidence(EVIDENCE, { ...EVIDENCE, snapshotId: 'snap-9' }))).toBe(true);
  });
});
