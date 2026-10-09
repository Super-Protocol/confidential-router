'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { BookOpen } from 'lucide-react';
import type * as React from 'react';
import { DataFlowDiagram } from '../gatekeeper/data-flow-diagram';
import { GatekeeperSetupBlock } from '../gatekeeper/setup-block';
import { WiringSnippet } from './wiring-snippet';

/**
 * Where the product documentation will live. The site is not up yet (its own
 * issue); the link is here so the console never has to change when it is.
 */
export const DOCS_URL = 'https://docs.router.superprotocol.com/';

export interface HowToConnectProps {
  /** The newest live key's visible prefix, or nothing — the snippet never carries a whole key. */
  apiKey?: string;
  /** A model this router will actually route to, so the snippet is runnable as pasted. */
  model?: string;
}

/**
 * Everything a reader needs to go from a key to a verified request, on the one
 * page the key is issued from.
 *
 * It replaces the standalone Gatekeeper screen (SUP-255): a reader who has just
 * copied a key wants to use it, and "how the connection works" and "what to run"
 * are one question. The commands are the shared setup block — the same one the
 * chat's tier-3 panel shows — so the two cannot drift (SUP-193), and the client
 * examples are the same snippets the created-key dialog fills in.
 */
export function HowToConnect({ apiKey, model }: HowToConnectProps) {
  return (
    <Card id="how-to-connect" className="mt-6 scroll-mt-20">
      <CardHeader>
        <CardTitle>
          <h2 className="font-semibold leading-none">How to connect</h2>
        </CardTitle>
        <CardDescription>
          Your client talks to a small proxy on your own machine, the Gatekeeper, which checks the router’s evidence
          before it forwards anything. Same OpenAI SDK, same model slug, same key — only the base URL changes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <Step number={1} title="How the connection works, and why there is a gatekeeper">
          <p className="max-w-prose text-muted-foreground text-sm leading-relaxed">
            This router runs inside a TEE and publishes signed evidence of what it is running, but it cannot verify
            itself for you — a verdict is only worth something when the party you are trusting did not produce it. The
            gatekeeper is that party: it fetches the router’s evidence, checks the cloud’s measurement against the Super
            Protocol registry of signed measurements, pins the TLS certificate the evidence names, and refuses to
            forward if any check fails. Nothing about that decision depends on the router being honest, and the router
            is never told that anyone verified it.
          </p>
          <DataFlowDiagram />
        </Step>

        <Step number={2} title="Install the gatekeeper and point it at this router">
          <p className="max-w-prose text-muted-foreground text-sm leading-relaxed">
            Five commands, already carrying this deployment’s own API origin — paste them as they are. Nothing is
            registered with the router at any point, and there is no certificate to trust: the gatekeeper checks this
            cloud against the registry of signed measurements.
          </p>
          <GatekeeperSetupBlock />
        </Step>

        <Step number={3} title="Point your client at it">
          <p className="max-w-prose text-muted-foreground text-sm leading-relaxed">
            Any OpenAI-compatible client works. Swap the base URL for the gatekeeper’s local address and nothing else
            changes.
          </p>
          <WiringSnippet apiKey={apiKey} model={model} />
          <p className="text-muted-foreground text-xs">
            Keys are stored hashed, so the snippet carries only the visible prefix. Paste the full key you copied when
            it was created.
          </p>
        </Step>

        <p className="flex items-center gap-2 text-sm">
          <BookOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium underline underline-offset-4 hover:text-brand-emphasis"
          >
            Details in the documentation
          </a>
        </p>
      </CardContent>
    </Card>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`how-to-connect-step-${number}`} className="space-y-3">
      <h3 id={`how-to-connect-step-${number}`} className="font-semibold text-base">
        <span className="mr-2 font-mono text-muted-foreground">{number}.</span>
        {title}
      </h3>
      {children}
    </section>
  );
}
