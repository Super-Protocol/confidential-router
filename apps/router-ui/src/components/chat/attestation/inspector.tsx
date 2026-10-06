'use client';

import { Badge } from '@confidential-router/ui/components/badge';
import { Button } from '@confidential-router/ui/components/button';
import { CopyButton } from '@confidential-router/ui/components/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@confidential-router/ui/components/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@confidential-router/ui/components/tabs';
import { RefreshCw } from 'lucide-react';
import * as React from 'react';
import { CheckRow } from '../verification/check-row';
import type { EndpointKind } from '../verification/evidence-gate';
import { badgeTier } from '../verification/tiers';
import type { VerificationState } from '../verification/use-verification';
import { DeploymentGraphView } from './deployment-graph';
import { buildDeploymentGraph, type DeclaredImage, type GraphNode } from './graph-model';
import { Measurements } from './measurements';
import { RawFields } from './raw-fields';

export interface AttestationInspectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The chat's own tier-1 and tier-2 results. Never re-run here. */
  verification: VerificationState;
  hostname: string;
  /** The catalogue's operator-declared TEE label. */
  teeLabel: string | null;
  /**
   * The endpoint's image allow-list, or null when it declares none.
   *
   * Always null for an external upstream: nobody declared what another
   * deployment runs, and v1 does not ask an operator to (ADR-008 §7). Null is
   * already "nothing was declared" to the graph, whose five-verdict logic then
   * draws the signed images without a comparison rather than reporting a
   * mismatch against an empty list.
   */
  declaredImages: readonly DeclaredImage[] | null;
  /** Whose endpoint this is. `external` changes the provenance copy and nothing else. */
  endpointKind?: EndpointKind;
}

/**
 * "Inspect attestation": every measurement the evidence carries, and the
 * deployment graph the signed document draws.
 *
 * ## It re-verifies nothing
 *
 * The whole panel is a function of `verification` — the `useVerification` result
 * the chat screen already holds. There is no second fetch, no second parse and no
 * second verifier anywhere in this directory, which is deliberate: two paths to
 * the same verdict is two things to keep in step, and the first time they diverge
 * the screen is showing one answer beside a badge that reached another. "Check
 * again" calls the chat's own `recheck`, so both surfaces move together.
 *
 * ## It refuses to draw unverified bytes
 *
 * `runEvidenceGate` returns `evidence: null` the moment a check fails, so a
 * failure cannot reach the graph even by accident — but the panel also says so
 * explicitly, in the words of the check that failed, rather than rendering an
 * empty canvas. A graph of a document whose signature did not verify would be
 * the most convincing wrong thing this product could put on a screen.
 *
 * ## It is a separate chunk
 *
 * react-flow is around a hundred kilobytes, and the chat is a screen most users
 * open to type a message. The component is reached only through
 * `inspect-button.tsx`'s dynamic import, and `code-split.spec.ts` fails the build
 * if a static import ever creeps in.
 */
export default function AttestationInspector({
  open,
  onOpenChange,
  verification,
  hostname,
  teeLabel,
  declaredImages,
  endpointKind = 'own',
}: AttestationInspectorProps) {
  const { gate, extension, checkedAt } = verification;
  const evidence = gate?.evidence ?? null;
  const tier = badgeTier(verification.pageState, verification.extensionState);
  const [openNode, setOpenNode] = React.useState<GraphNode | null>(null);
  /*
   * Which tab is open, held here rather than left to `Tabs`' own `defaultValue`.
   *
   * "Check again" sets the gate back to null for the length of the re-run, which
   * unmounts the tabs along with everything else they contain — and a remounted
   * `Tabs` goes back to its default. A reader who pressed it while looking at the
   * graph was returned to the measurements list, which is the one moment they are
   * most likely to be watching a specific node.
   */
  const [tab, setTab] = React.useState('measurements');

  const graph = React.useMemo(
    () => buildDeploymentGraph({ snapshot: evidence?.snapshot, declaredImages }),
    [evidence?.snapshot, declaredImages],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Full-bleed rather than a centred card: the graph needs the width, and a
        reader comparing a dozen digests should not be doing it in a 640-pixel
        column. `sm:max-w-none` undoes the shared DialogContent's own cap.
      */}
      <DialogContent
        showCloseButton
        className="flex h-[96vh] w-[98vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogHeader className="border-b px-6 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>
              {endpointKind === 'external' ? 'Attestation for this external upstream' : 'Attestation for this endpoint'}
            </DialogTitle>
            <Badge variant={tier.variant}>{tier.label}</Badge>
          </div>
          <DialogDescription className="max-w-prose">
            <span className="break-all font-mono text-xs">{hostname}</span>
            {/*
              The badge's caveat, verbatim, because this panel is the screen most
              likely to be mistaken for a verdict: it is the one with the
              measurements and the graph on it.
            */}
            <span className="mt-1 block">{tier.caveat}</span>
            {endpointKind === 'external' ? (
              /*
                And the one thing the tier caveat cannot say, because it is about
                tiers rather than topology: your prompts do not travel to this
                host over a channel your browser opened. They go to this router,
                which proxies over a connection its own egress attested and
                pinned. What this panel establishes is that the document below is
                genuinely this upstream's, signed and fresh — not that the leg
                carrying your prompt is the leg the document describes.
              */
              <span className="mt-1 block">
                This is a deployment in someone else’s cluster. Your connection terminates at this router, which proxies
                to it over a channel its egress attested and pinned — so what follows is the upstream’s own signed
                evidence, verified in this page, and not a statement about the hop your prompt takes.
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {gate === null ? (
            <p className="text-muted-foreground text-sm" role="status">
              {endpointKind === 'external'
                ? 'Fetching this upstream’s signed evidence through this router’s relay and checking it here in your browser…'
                : 'Fetching this endpoint’s signed evidence and checking it here in your browser…'}
            </p>
          ) : evidence === null ? (
            <Degraded gate={gate} />
          ) : (
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="measurements">Measurements</TabsTrigger>
                <TabsTrigger value="graph">Deployment graph</TabsTrigger>
              </TabsList>
              <TabsContent value="measurements" className="pt-4">
                <Measurements
                  hostname={hostname}
                  endpointKind={endpointKind}
                  teeLabel={teeLabel}
                  gate={gate}
                  evidence={evidence}
                  extension={extension}
                  checkedAt={checkedAt}
                  graph={graph}
                />
              </TabsContent>
              <TabsContent value="graph" className="pt-4">
                {graph.problem ? (
                  <p className="max-w-prose text-muted-foreground text-sm">{graph.problem}</p>
                ) : (
                  <DeploymentGraphView graph={graph} onOpenNode={setOpenNode} />
                )}
              </TabsContent>
            </Tabs>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t px-6 py-3">
          <Button variant="outline" size="sm" onClick={verification.recheck}>
            <RefreshCw aria-hidden="true" />
            Check again
          </Button>
          {evidence ? (
            <CopyButton
              value={evidence.jws}
              label="Copy the signed evidence (JWS)"
              showLabel
              variant="outline"
              size="sm"
            />
          ) : null}
        </div>
      </DialogContent>
      <RawFields node={openNode} onClose={() => setOpenNode(null)} />
    </Dialog>
  );
}

/**
 * What the panel shows when tier 1 did not pass: the checks as they stand, and
 * nothing drawn from the bytes.
 *
 * The same rows the badge's panel lists, through the same component, so the
 * failure reads identically wherever a reader meets it.
 */
function Degraded({ gate }: { gate: NonNullable<VerificationState['gate']> }) {
  return (
    <div className="space-y-4">
      <p className="max-w-prose text-sm">
        Nothing below is drawn from this endpoint’s evidence, because the evidence did not check out. A graph of a
        document whose signature or chain failed would look exactly like one that passed, so none is rendered.
      </p>
      <ul className="space-y-2">
        {gate.checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </ul>
    </div>
  );
}
