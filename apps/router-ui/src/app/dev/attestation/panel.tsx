'use client';

import * as React from 'react';
import { InspectAttestationButton } from '../../../components/chat/attestation/inspect-button';
import { PageHeader } from '../../../components/page-header';
import {
  DECLARED_IMAGES,
  gateEvidence,
  INSPECTED_HOSTNAME,
  PASSING_GATE_CHECKS,
  SIGNED_SNAPSHOT,
  verificationState,
} from '../../../test-fixtures';

/**
 * The attestation inspector over a fixed document, for visual and accessibility
 * review.
 *
 * It exists because the panel's own screen cannot be audited where the audit
 * runs. Tier 1 needs Web Crypto, browsers withhold Web Crypto from a named http
 * origin, and `apps/router-ui-e2e` serves the console from
 * `http://console.localtest.me:4300` on purpose so that cookie behaviour matches
 * production (`origins.ts`). So on the chat screen the e2e suite can only ever
 * see the panel's degraded state — which is worth testing and *is* tested, but
 * says nothing about keyboard navigation through a graph that is not there.
 *
 * This route hands the same component the same verification result the component
 * tests use, with no verifier involved, and the suite audits it with axe and walks
 * it with Tab. `/dev/components` already works this way for the design system.
 */
export function AttestationReviewPanel() {
  const verification = React.useMemo(() => verificationState(), []);
  /** The doctored case, so the loud-red path is reviewed as well as the clean one. */
  const undeclared = React.useMemo(() => {
    const snapshot = structuredClone(SIGNED_SNAPSHOT) as { resources: { kind: string }[] };
    const deployment = snapshot.resources.find((resource) => resource.kind === 'StatefulSet') as unknown as {
      spec: { template: { spec: { containers: { image: string }[] } } };
    };
    const container = deployment.spec.template.spec.containers[0] as { image: string };
    container.image = `docker.io/library/nginx@sha256:${'4'.repeat(64)}`;
    return verificationState({
      gate: { unlocked: true, checks: PASSING_GATE_CHECKS, registry: null, evidence: gateEvidence({ snapshot }) },
    });
  }, []);

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-10">
      <PageHeader
        title="Attestation inspector"
        description="The chat's “Inspect attestation” panel over a fixed signed document. A review surface, not a product page: no verifier runs here."
      />

      <section className="space-y-2">
        <h2 className="font-medium text-sm">Every image declared</h2>
        <InspectAttestationButton
          verification={verification}
          hostname={INSPECTED_HOSTNAME}
          teeLabel="Intel TDX + H100 CC"
          declaredImages={DECLARED_IMAGES}
        />
      </section>

      <section className="space-y-2">
        <h2 className="font-medium text-sm">One container running an undeclared image</h2>
        <InspectAttestationButton
          verification={undeclared}
          hostname={INSPECTED_HOSTNAME}
          teeLabel="Intel TDX + H100 CC"
          declaredImages={DECLARED_IMAGES}
        />
      </section>

      <section className="space-y-2">
        <h2 className="font-medium text-sm">No allow-list declared</h2>
        <InspectAttestationButton
          verification={verification}
          hostname={INSPECTED_HOSTNAME}
          teeLabel="Intel TDX + H100 CC"
          declaredImages={null}
        />
      </section>
    </div>
  );
}
