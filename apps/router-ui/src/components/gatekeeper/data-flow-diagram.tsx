import { ArrowRight, ShieldCheck } from 'lucide-react';

/**
 * Where the gatekeeper sits, and which side of the boundary each part is on.
 *
 * The three stages are ordinary text rather than an image, so the diagram is
 * readable by a screen reader and searchable; only the arrows are decorative.
 */
export function DataFlowDiagram() {
  return (
    <figure className="rounded-lg border p-4 sm:p-6">
      <figcaption className="sr-only">
        Your agents talk to a gatekeeper on your machine, which verifies the confidential endpoint's evidence before
        forwarding anything to it.
      </figcaption>

      <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-center">
        <Stage
          label="Your machine"
          title="Your agents"
          detail="Unchanged code. An OpenAI-compatible client pointed at localhost."
        />

        <Connector label="plain HTTP" />

        <Stage
          label="You run this"
          title="Gatekeeper"
          detail="Verifies the enclave, then forwards. Never forwards first."
          highlighted
        />

        <Connector label="TLS, once verified" highlighted />

        <Stage
          label="Enclave boundary"
          title="Confidential endpoint"
          detail="Model weights and prompts sealed in hardware. The operator cannot read them."
        />
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-md border border-dashed p-3 text-muted-foreground text-xs">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand-emphasis" aria-hidden="true" />
        <p>
          <span className="font-medium text-foreground">Evidence path.</span> The endpoint publishes its signed bundle
          at <code className="font-mono">/.well-known/swarm-evidence</code>; the gatekeeper fetches it and decides. The
          verdict stays on your machine — the router is never told that anyone verified it.
        </p>
      </div>
    </figure>
  );
}

function Stage({
  label,
  title,
  detail,
  highlighted,
}: {
  label: string;
  title: string;
  detail: string;
  highlighted?: boolean;
}) {
  return (
    <div
      className={
        highlighted
          ? 'flex-1 rounded-lg border border-brand-border bg-brand-muted p-4'
          : 'flex-1 rounded-lg border bg-muted/30 p-4'
      }
    >
      <p
        className={
          highlighted
            ? 'mb-1.5 font-medium text-brand-emphasis text-xs uppercase tracking-wide'
            : 'mb-1.5 text-muted-foreground text-xs uppercase tracking-wide'
        }
      >
        {label}
      </p>
      <p className="font-medium text-sm">{title}</p>
      <p className="mt-1 text-muted-foreground text-xs leading-relaxed">{detail}</p>
    </div>
  );
}

function Connector({ label, highlighted }: { label: string; highlighted?: boolean }) {
  return (
    <div className="flex shrink-0 items-center justify-center gap-1.5 lg:flex-col lg:gap-1" aria-hidden="true">
      <span className={highlighted ? 'text-brand-emphasis text-xs' : 'text-muted-foreground text-xs'}>{label}</span>
      <ArrowRight
        className={
          highlighted
            ? 'size-4 rotate-90 text-brand-emphasis lg:rotate-0'
            : 'size-4 rotate-90 text-muted-foreground lg:rotate-0'
        }
      />
    </div>
  );
}
