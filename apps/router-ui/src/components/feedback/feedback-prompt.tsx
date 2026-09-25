'use client';

import { ExternalLink } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { formatUsd } from '../../lib/format';
import { useSession } from '../session/session-provider';
import { useFeedbackOffer } from './use-feedback-offer';

/** Where the offer already has a card of its own; a second copy would be noise. */
const CREDITS_PATH = '/credits';

/**
 * The prompt a viewer meets when a request has just been refused for want of
 * credit.
 *
 * Non-blocking by construction — a strip above the page, not a dialog. Someone
 * whose experiment just stopped mid-run is entitled to go and read their logs
 * without answering a survey first, and a modal at that moment would be the
 * console charging for its own apology.
 *
 * It appears only where the balance is actually spent out, because the offer's
 * own eligibility rule is more generous than that: the server offers below $5 so
 * the message arrives *before* the wall, and the Credits screen is where that
 * earlier, gentler version lives.
 */
export function FeedbackPrompt() {
  const pathname = usePathname();
  const { activeWorkspace, refetch } = useSession();
  const { offer, waiting, opened } = useFeedbackOffer(refetch);

  const spentOut = Number(activeWorkspace?.balanceMicros ?? '0') <= 0;
  if (!offer?.formUrl || !spentOut || pathname === CREDITS_PATH) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid="feedback-prompt"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-border border-b bg-brand/5 px-4 py-2.5 text-sm lg:px-7"
    >
      <span className="font-medium">
        Out of credits. Tell us how it went and we will add another {formatUsd(offer.grantMicros)}.
      </span>
      <span className="text-muted-foreground">
        {waiting ? 'Thanks — the credit lands within a minute of you submitting.' : 'About three minutes.'}
      </span>
      <a
        className="ml-auto inline-flex items-center gap-1 font-medium underline underline-offset-4"
        href={offer.formUrl}
        target="_blank"
        rel="noreferrer noopener"
        onClick={opened}
      >
        Give feedback
        <ExternalLink className="size-3.5" aria-hidden="true" />
      </a>
    </div>
  );
}
