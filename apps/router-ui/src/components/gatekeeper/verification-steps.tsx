import type * as React from 'react';

/**
 * The verification pipeline, in the order `pkg/attestation` runs it. Any one of
 * the four failing is a refusal, which is why they are numbered rather than
 * bulleted.
 */
const STEPS: { title: string; detail: React.ReactNode }[] = [
  {
    title: 'Fetch the evidence',
    detail: (
      <>
        <code className="font-mono">GET /.well-known/swarm-evidence</code> from the endpoint it is about to talk to.
      </>
    ),
  },
  {
    title: 'Validate the certificate chain',
    detail: (
      <>
        Leaf to root. The root has to be one you trusted yourself, or one that proves it is a Super Swarm root: its
        certificate carries the attestation of the TEE it runs in, and the measurement of that TEE has to be one Super
        Protocol signed.
      </>
    ),
  },
  {
    title: 'Verify the signature',
    detail: <>The JWS is checked with the leaf public key, and the bundle must be fresh enough for your policy.</>,
  },
  {
    title: 'Bind it to the connection',
    detail: (
      <>
        The <code className="font-mono">certFingerprint</code> in the payload must match the TLS certificate this
        session is actually presenting — otherwise the evidence belongs to some other host.
      </>
    ),
  },
];

export function VerificationSteps() {
  return (
    <ol className="grid gap-3 sm:grid-cols-2">
      {STEPS.map((step, index) => (
        <li key={step.title} className="flex gap-3 rounded-lg border p-4">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-muted font-mono text-brand-emphasis text-xs">
            {index + 1}
          </span>
          <div>
            <p className="font-medium text-sm">{step.title}</p>
            <p className="mt-1 text-muted-foreground text-xs leading-relaxed">{step.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
