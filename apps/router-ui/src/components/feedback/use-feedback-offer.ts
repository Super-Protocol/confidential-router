'use client';

import { useQuery } from '@apollo/client/react';
import * as React from 'react';
import { toast } from 'sonner';
import { FEEDBACK_OFFER } from './operations';

/** While waiting for the webhook. The grant is usually there on the first or second poll. */
const WAITING_POLL_MS = 5_000;

/**
 * While merely eligible.
 *
 * Long, and its only job is to keep the link's token fresh: the token expires in
 * minutes, and a Credits tab left open all afternoon would otherwise hand the
 * viewer a link that is already dead by the time they click it.
 */
const IDLE_POLL_MS = 10 * 60_000;

/** How long to keep watching before giving up quietly. */
const WAITING_TIMEOUT_MS = 3 * 60_000;

export interface FeedbackOfferState {
  /** Non-null only while the viewer is actually being offered the grant. */
  offer: { grantMicros: string; formUrl: string | null } | null;
  /** True between opening the form and the grant landing. */
  waiting: boolean;
  /** Call from the link's `onClick`, once the browser has the tab open. */
  opened: () => void;
}

/**
 * The second-grant offer, and the wait for it to land.
 *
 * The form opens in another tab and the grant arrives by webhook, so there is no
 * response to await: this polls until the grant shows up, then says so. Nothing
 * here decides anything — `eligible` and `formUrl` are the server's
 * (`feedback-eligibility.service.ts`), and the balance is read back rather than
 * predicted, for the same reason the Stripe return only triggers a refetch.
 */
export function useFeedbackOffer(onGranted?: () => void): FeedbackOfferState {
  const [waiting, setWaiting] = React.useState(false);
  const { data, refetch, startPolling, stopPolling } = useQuery(FEEDBACK_OFFER, {
    // The offer changes with the balance, which every generation moves.
    fetchPolicy: 'cache-and-network',
  });

  const offer = data?.feedbackOffer ?? null;
  const eligible = offer?.eligible ?? false;
  const granted = offer?.granted ?? null;

  React.useEffect(() => {
    // Nothing to poll for a viewer who is not being offered anything.
    const interval = waiting ? WAITING_POLL_MS : eligible ? IDLE_POLL_MS : 0;
    if (interval === 0) {
      stopPolling();
      return;
    }
    startPolling(interval);
    return () => stopPolling();
  }, [waiting, eligible, startPolling, stopPolling]);

  React.useEffect(() => {
    if (!waiting || !granted) {
      return;
    }
    setWaiting(false);
    toast.success('Thank you. Another $100 has been added to this workspace.');
    onGranted?.();
  }, [waiting, granted, onGranted]);

  React.useEffect(() => {
    if (!waiting) {
      return;
    }
    // A viewer who opened the form and never submitted must not leave the
    // console polling for the rest of the session.
    const timer = setTimeout(() => setWaiting(false), WAITING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  const opened = React.useCallback(() => {
    setWaiting(true);
    void refetch();
  }, [refetch]);

  return {
    offer: eligible && offer ? { grantMicros: offer.grantMicros, formUrl: offer.formUrl } : null,
    waiting,
    opened,
  };
}
