'use client';

import { InfoPopover } from '../info-popover';
import type { HistoryCopy } from './verification/tiers';

export interface StorageNoteProps {
  /** From `HISTORY_COPY`, keyed on what the deployment says it does. */
  copy: HistoryCopy;
  /**
   * Puts the reader in front of the control that deletes the open conversation.
   * Absent when there is no conversation to delete, which hides the affordance
   * rather than offering one that would do nothing.
   */
  onRevealDelete?: () => void;
}

/**
 * Where the conversation is kept: one affirmative line, and the whole story
 * behind an ⓘ.
 *
 * Both halves shipped inline in 0.8.0, which put "may be lost during
 * maintenance" permanently under the composer of the product's main demo
 * surface — a warning banner on the screen a prospect is shown first. The
 * honesty requirement is unchanged (CTO review, SUP-180): every qualification
 * still ships, in the policy's own words, and the trigger's accessible name says
 * there is something to read. What changed is that the reader opens it.
 *
 * The caveat lives *only* here, never in the line, and the deletion sentence
 * carries a way to reach the control rather than a description of where it is:
 * the link moves focus to the open conversation's row, which reveals the bin
 * beside it (hidden until the row is hovered or focused) and closes this
 * popover, because Radix dismisses on focus leaving the layer. The row rather
 * than the bin itself — the bin deletes without confirming, and nobody who
 * followed a link to *see* a control should be one keystroke from firing it.
 */
export function StorageNote({ copy, onRevealDelete }: StorageNoteProps) {
  return (
    <div className="flex items-center gap-1.5">
      <p className="text-foreground text-xs">{copy.summary}</p>
      <InfoPopover label="What this means for your conversations">
        <p>
          {copy.detail}
          {onRevealDelete ? (
            <>
              {' '}
              <button
                type="button"
                onClick={onRevealDelete}
                className="rounded underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                Show the delete control
              </button>
              .
            </>
          ) : null}
        </p>
        {copy.maintenanceCaveat === null ? null : <p className="text-foreground">{copy.maintenanceCaveat}</p>}
        <p>{copy.transport}</p>
      </InfoPopover>
    </div>
  );
}
