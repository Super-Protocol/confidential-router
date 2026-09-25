'use client';

import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent } from '@confidential-router/ui/components/card';
import { ExternalLink, MessageSquareHeart } from 'lucide-react';
import { formatUsd } from '../../lib/format';
import { useFeedbackOffer } from './use-feedback-offer';

/**
 * The offer, on the Credits screen.
 *
 * Renders nothing at all unless the server says this account is eligible, which
 * is most accounts most of the time — the offer only exists for someone who
 * redeemed the first grant, used it, and has nearly run it out.
 *
 * The call to action is a real link rather than a scripted `window.open`: the
 * form is another origin, and a popup opened from a handler is the thing
 * browsers block.
 */
export function FeedbackOfferCard({ onGranted }: { onGranted?: () => void }) {
  const { offer, waiting, opened } = useFeedbackOffer(onGranted);

  if (!offer?.formUrl) {
    return null;
  }

  return (
    <Card data-testid="feedback-offer">
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand-emphasis">
            <MessageSquareHeart className="size-4" aria-hidden="true" />
          </span>
          <div className="space-y-1">
            <p className="font-semibold text-sm">
              Out of credits. Tell us how it went and we will add another {formatUsd(offer.grantMicros)}.
            </p>
            <p className="text-muted-foreground text-sm">
              {waiting
                ? 'Thanks — once you submit, the credit lands within a minute. This page updates by itself.'
                : 'A few questions about what you built and what was missing. It takes about three minutes.'}
            </p>
          </div>
        </div>

        <Button asChild className="shrink-0">
          <a href={offer.formUrl} target="_blank" rel="noreferrer noopener" onClick={opened}>
            Give feedback
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}
