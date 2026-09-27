'use client';

import { useQuery } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent } from '@confidential-router/ui/components/card';
import { CodeBlock } from '@confidential-router/ui/components/code-block';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { graphql } from '../../generated';
import { formatUsdShort } from '../../lib/format';
import { PLACEHOLDER_KEY, wiringSnippet } from '../keys/snippets';
import { useSession } from '../session/session-provider';

/**
 * Whether this workspace has a key yet, and what to name in the snippet. Nothing
 * else: the card is about the one step that is missing, so a full `apiKeys` page
 * would be asking for rows to throw away.
 *
 * The catalogue rides along because the snippet has to name a model that exists.
 * It used to name a hardcoded placeholder, which meant the first thing an invited
 * account was offered to copy answered `404 model_not_found` (SUP-153). One query,
 * so the card cannot paint with a key answer and no model.
 */
export const NEXT_STEP_QUERY = graphql(`
  query NextStep($workspaceId: ID!) {
    apiKeys(workspaceId: $workspaceId) {
      id
      revokedAt
    }
    models {
      id
    }
  }
`);

/**
 * The one thing that matters next, for an account with credit and no key.
 *
 * It is the gap the launch campaign is judged on. `first_request_sent` is the
 * event the whole thing is measured by, and the distance between "the $100 is
 * here" and "a token was sent" is exactly two steps — create a key, paste one
 * snippet. So the card is not a checklist and not a tour: it is those two steps,
 * with the snippet already written out, and it disappears the moment the first key
 * exists.
 *
 * Deliberately conditional on *credit*, not on a key alone. A workspace with no
 * balance cannot send a request even with a key, and telling it to try would be
 * sending it into a `402`.
 */
export function NextStepCard(): React.ReactElement | null {
  const { activeWorkspace } = useSession();
  const workspaceId = activeWorkspace?.id;
  const balanceMicros = activeWorkspace?.balanceMicros ?? '0';
  const hasCredit = BigInt(balanceMicros) > 0n;

  const { data } = useQuery(NEXT_STEP_QUERY, {
    variables: { workspaceId: workspaceId ?? '' },
    skip: !workspaceId || !hasCredit,
    fetchPolicy: 'cache-and-network',
  });

  if (!workspaceId || !hasCredit || !data) {
    return null;
  }
  if (data.apiKeys.some((key) => key.revokedAt === null)) {
    return null;
  }

  // The catalogue's first model, which is what the Keys screen names too. Absent
  // only on a deployment that serves nothing — and then there is no snippet worth
  // offering, so the card keeps the step and drops the paste.
  const sampleModel = data.models[0]?.id;

  return (
    <Card className="border-brand-border" data-testid="next-step-card">
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="font-medium text-sm">You have {formatUsdShort(balanceMicros)} to spend. One step to go.</p>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Create a key, change the base URL in your OpenAI client, and the next request runs inside a TEE.
            </p>
          </div>
          <Button variant="brand" size="sm" asChild className="shrink-0">
            <Link href="/keys">
              Create a key
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>

        {/*
          Python, and only Python. The Keys screen offers all three languages next
          to the key it has just minted; here the point is that adopting the router
          is one base-URL swap, and three tabs of the same claim make it look like
          more work than it is. The key is a placeholder because the console cannot
          read a secret back — and there is no key yet anyway. The model is not: it
          comes from the catalogue, so the snippet is runnable as pasted.
        */}
        {sampleModel ? (
          <CodeBlock
            title="Python"
            code={wiringSnippet('python', { apiKey: PLACEHOLDER_KEY, model: sampleModel })}
            copyLabel="Copy the Python snippet"
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
