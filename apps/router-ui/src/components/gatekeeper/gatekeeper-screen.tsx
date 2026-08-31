'use client';

import { useQuery } from '@apollo/client/react';
import { CodeBlock } from '@confidential-router/ui/components/code-block';
import { CopyButton } from '@confidential-router/ui/components/copy-button';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { PackageOpen } from 'lucide-react';
import { PageHeader } from '../page-header';
import { DataFlowDiagram } from './data-flow-diagram';
import { ComingLater, DownloadTable, ReleaseMeta } from './downloads';
import { FailModeExplainer } from './fail-mode-explainer';
import { GATEKEEPER_RELEASE_QUERY } from './operations';
import { SETUP_STEPS, setupScript } from './setup-commands';
import { VerificationSteps } from './verification-steps';

/**
 * Download and instructions only.
 *
 * There is deliberately no state here: the router does not know when, whether
 * or by whom it is attested (ADR-002), so there is nothing to enrol, no
 * instance list and no verdict to report back.
 */
export function GatekeeperScreen() {
  const { data, loading, error, refetch } = useQuery(GATEKEEPER_RELEASE_QUERY);
  const release = data?.gatekeeperRelease ?? null;

  return (
    <>
      <PageHeader
        title="Gatekeeper"
        description="A confidential endpoint you cannot check is just a promise. Gatekeeper is the part you run yourself — a small proxy between your agents and the model that refuses to forward anything until the enclave has proved what it is."
      />

      <div className="space-y-8">
        <DataFlowDiagram />

        <section className="space-y-3" aria-labelledby="verification-heading">
          <div>
            <h2 id="verification-heading" className="font-semibold text-base">
              What it checks, before anything leaves your machine
            </h2>
            <p className="text-muted-foreground text-sm">
              Four checks, in this order, on every re-attestation. All four must pass.
            </p>
          </div>
          <VerificationSteps />
          <FailModeExplainer />
        </section>

        <section className="space-y-3" aria-labelledby="download-heading">
          <div>
            <h2 id="download-heading" className="font-semibold text-base">
              Download
            </h2>
            <p className="text-muted-foreground text-sm">
              One static Go binary, no runtime dependencies. Verify what you downloaded against the published checksums
              before you run it.
            </p>
          </div>

          {error ? (
            <ErrorState
              title="The release could not be loaded"
              description="The console could not read the published gatekeeper build."
              detail="GatekeeperRelease"
              onRetry={() => void refetch()}
            />
          ) : loading && !release ? (
            <div className="space-y-2" data-testid="gatekeeper-release-loading">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : release === null ? (
            <EmptyState
              icon={<PackageOpen className="size-5" aria-hidden="true" />}
              title="No published build yet"
              description="This router has not retrieved a gatekeeper release from GitHub. The setup below is unchanged once one is published."
            />
          ) : (
            <div className="space-y-3">
              <ReleaseMeta release={release} />
              <DownloadTable release={release} />
            </div>
          )}

          <ComingLater />
        </section>

        <section className="space-y-3" aria-labelledby="setup-heading">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 id="setup-heading" className="font-semibold text-base">
                Set it up
              </h2>
              <p className="text-muted-foreground text-sm">
                Four commands. Nothing is registered with the router at any point.
              </p>
            </div>
            <CopyButton value={setupScript()} label="Copy all four commands" variant="outline" size="sm" showLabel />
          </div>

          <ol className="space-y-3">
            {SETUP_STEPS.map((step, index) => (
              <li key={step.command} className="rounded-lg border p-4">
                <p className="font-medium text-sm">
                  <span className="mr-2 font-mono text-muted-foreground">{index + 1}.</span>
                  {step.title}
                </p>
                <p className="mt-1 mb-3 text-muted-foreground text-xs leading-relaxed">{step.detail}</p>
                <CodeBlock code={step.command} copyLabel={`Copy: ${step.title}`} />
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
