'use client';

import { cn } from '@confidential-router/ui/lib/utils';
import { PREVIEW_DATA_COPY } from './chat/verification/tiers';
import { InfoPopover } from './info-popover';

export interface PreviewDataNoticeProps {
  /** Layout only — spacing and separators belong to the surface, not the notice. */
  className?: string;
}

/**
 * The Private Preview's personal-data restriction, on the two screens where
 * content is about to leave: the chat composer's footer and the dialog that
 * hands over a new API key (SUP-501).
 *
 * `StorageNote` is the model, deliberately. The same requirement arrived there
 * first — a true sentence that nobody has to be alarmed by, on the product's
 * main demo surface — and the first version of it shipped inline, which put a
 * standing warning under the composer of the screen a prospect is shown first.
 * So: the condition stated affirmatively in the layout, counsel's reviewed
 * sentence behind an ⓘ that names what is behind it, and the clause it comes
 * from linked rather than described.
 *
 * What it is not, and must not become: a gate. Counsel's own note is the bound —
 * *"this text does not replace acceptance of the Terms"* — so there is no
 * checkbox, nothing to dismiss, and nothing written to browser storage to
 * remember a dismissal.
 */
export function PreviewDataNotice({ className }: PreviewDataNoticeProps) {
  return (
    <div className={cn('flex items-center gap-1.5', className)} data-testid="preview-data-notice">
      <p className="text-foreground text-xs">{PREVIEW_DATA_COPY.summary}</p>
      <InfoPopover label="What the Private Preview asks you not to submit">
        <p>{PREVIEW_DATA_COPY.restriction}</p>
        <p>
          {PREVIEW_DATA_COPY.standing}{' '}
          <a
            href={PREVIEW_DATA_COPY.termsUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {PREVIEW_DATA_COPY.termsLabel}
          </a>
        </p>
      </InfoPopover>
    </div>
  );
}
