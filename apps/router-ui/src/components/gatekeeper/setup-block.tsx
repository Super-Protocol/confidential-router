'use client';

import { CodeBlock } from '@confidential-router/ui/components/code-block';
import { CopyButton } from '@confidential-router/ui/components/copy-button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@confidential-router/ui/components/tabs';
import * as React from 'react';
import { publicConfig } from '../../lib/public-config';
import { INSTALL_COMMANDS } from './install-commands';
import { setupScript, setupSteps } from './setup-commands';

export interface GatekeeperSetupBlockProps {
  /**
   * The origin the gatekeeper should front. Defaults to this deployment's API
   * origin, read from the runtime public config (SUP-100) rather than inlined at
   * build time; the chat panel passes the endpoint it has just verified.
   */
  upstream?: string;
  /** Pin this digest outright; absent takes the published one with `--from-upstream`. */
  evidenceDigestHex?: string | null;
}

/**
 * The pre-filled Gatekeeper setup sequence — one component, two screens.
 *
 * `/gatekeeper` and the chat's tier-3 "verify it yourself" panel used to build
 * the same commands from the same data through two different pieces of markup,
 * one of them with the placeholders still in. That is the shape of drift
 * SUP-153/165 cost us on the model catalogue, so the block itself is shared and
 * neither screen writes a command of its own (SUP-193).
 *
 * Every value is resolved: the upstream from the deployment's own configuration,
 * the trust root from where the platform publishes it, the pin either from the
 * evidence the caller already holds or from `--from-upstream`. There is nothing
 * for a reader to substitute, which is why there is no input here either.
 */
export function GatekeeperSetupBlock({ upstream, evidenceDigestHex = null }: GatekeeperSetupBlockProps) {
  const config = publicConfig();
  // Two of the six lines are a pipe, and the two shells do not spell one the
  // same way — so the platform is a control on the whole block rather than a
  // footnote under one line: a reader copies one sequence, in their own shell.
  const [platformId, setPlatformId] = React.useState<string>(INSTALL_COMMANDS[0].id);
  const platform = INSTALL_COMMANDS.find((entry) => entry.id === platformId) ?? INSTALL_COMMANDS[0];

  const inputFor = (entry: typeof platform) => ({
    upstream: upstream ?? config.apiOrigin,
    swarmRootPemUrl: config.swarmRootPemUrl,
    platform: entry,
    evidenceDigestHex,
  });

  return (
    <Tabs
      value={platformId}
      onValueChange={setPlatformId}
      className="gap-3"
      data-testid="gatekeeper-setup"
      aria-label="Gatekeeper setup"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TabsList>
          {INSTALL_COMMANDS.map((entry) => (
            <TabsTrigger key={entry.id} value={entry.id}>
              {entry.platform}
            </TabsTrigger>
          ))}
        </TabsList>
        <CopyButton
          value={setupScript(inputFor(platform))}
          label="Copy the whole sequence"
          variant="outline"
          size="sm"
          showLabel
        />
      </div>

      {INSTALL_COMMANDS.map((entry) => (
        <TabsContent key={entry.id} value={entry.id}>
          <ol className="space-y-3">
            {setupSteps(inputFor(entry)).map((step, index) => (
              <li key={step.id} className="rounded-lg border p-4">
                <p className="font-medium text-sm">
                  <span className="mr-2 font-mono text-muted-foreground">{index + 1}.</span>
                  {step.title}
                </p>
                <p className="mt-1 mb-3 text-muted-foreground text-xs leading-relaxed">{step.detail}</p>
                <CodeBlock code={step.command} copyLabel={`Copy: ${step.title}`} />
              </li>
            ))}
          </ol>
        </TabsContent>
      ))}
    </Tabs>
  );
}
