import { TriangleAlert } from 'lucide-react';
import type * as React from 'react';

/**
 * The cloud-granularity warning, written once.
 *
 * It is a product requirement rather than a nicety: decision 1 buys runtime
 * registration with a trust unit coarser than a deployment, and threat T13 is
 * the residual risk Denis accepted *on the condition that the UI says so
 * wherever the list is edited*. The sentence is the design's own words — "a
 * measurement admits a cloud, never a deployment" (ADR-008 §3, SUP-139) — so a
 * reader who meets it here and in the gatekeeper CLI meets the same sentence.
 *
 * Exported as one constant because three surfaces show it (the trust screen, the
 * add dialog, the remove dialog) and three paraphrases would be three different
 * promises.
 */
export const CLOUD_GRANULARITY_WARNING = 'A measurement admits a cloud, never a deployment.';

export const CLOUD_GRANULARITY_DETAIL =
  'Any confidential VM running on a cloud whose launch measurement is on this list satisfies the check — including one someone else deployed there. This list is the sole authority on admission: a registry signature does not admit on its own.';

export const REMOVAL_WARNING =
  'Removing a measurement takes effect on the next check, not after the re-attestation interval. Every endpoint it was admitting is denied on that check, its models leave /v1/models, and its in-flight connections close.';

/**
 * The standing callout. `role="note"` rather than `role="alert"`: it is always
 * on screen and describes a property of the feature, so announcing it as an
 * alert would interrupt a screen reader on every visit.
 */
export function CloudGranularityWarning({ children }: { children?: React.ReactNode }) {
  return (
    <div
      role="note"
      aria-label="How measurement trust works"
      className="flex gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium">{CLOUD_GRANULARITY_WARNING}</p>
        <p className="text-muted-foreground">{CLOUD_GRANULARITY_DETAIL}</p>
        {children}
      </div>
    </div>
  );
}
