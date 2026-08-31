import { Badge } from '@confidential-router/ui/components/badge';
import { ShieldCheck, ShieldOff } from 'lucide-react';

/**
 * Fail-closed against fail-open, said plainly.
 *
 * Fail-open is a real option — an evaluation harness that must not stall is a
 * legitimate reason — but it is per-endpoint and opt-in, and the page says what
 * it costs rather than presenting the two as equivalent.
 */
export function FailModeExplainer() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-lg border border-brand-border bg-brand-muted/40 p-4">
        <div className="mb-2 flex items-center gap-2">
          <ShieldCheck className="size-4 text-brand-emphasis" aria-hidden="true" />
          <p className="font-medium text-sm">Fail closed</p>
          <Badge variant="brand">Default</Badge>
        </div>
        <p className="text-muted-foreground text-xs leading-relaxed">
          If any check fails, the request is dropped inside the gatekeeper, on your hardware. Your prompt is never
          transmitted and the failure lands in your local log — not in ours. Nothing about that decision depends on the
          router being honest.
        </p>
      </div>

      <div className="rounded-lg border border-warning/40 p-4">
        <div className="mb-2 flex items-center gap-2">
          <ShieldOff className="size-4 text-warning" aria-hidden="true" />
          <p className="font-medium text-sm">Fail open</p>
          <Badge variant="warning">Opt in</Badge>
        </div>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Set <code className="font-mono">failMode: open</code> on one endpoint and traffic is forwarded even when
          verification fails, with the failure logged. That is a plain TLS proxy to an unverified host: use it to keep a
          benchmark running, never to carry data you would not send to an unattested endpoint.
        </p>
      </div>
    </div>
  );
}
