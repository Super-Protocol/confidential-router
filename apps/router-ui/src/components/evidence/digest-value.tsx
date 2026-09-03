import { CopyButton } from '@confidential-router/ui/components/copy-button';
import { formatDigest, shortenDigest } from '../../lib/format';

export interface DigestValueProps {
  /** The hex spelling the API sends alongside every fingerprint. */
  hex: string;
  /** The canonical `sha256/<base64url>` one, used only if the hex form is missing. */
  canonical: string;
  /** Accessible label of the copy button; omit it for a value that is not copied. */
  copyLabel?: string;
  /** Characters kept at each end of the truncated form. */
  keep?: number;
}

/**
 * A digest as every screen shows one: truncated `sha256:<hex>`, full value in
 * the tooltip, and — where it is something a user acts on — a copy button that
 * copies the whole thing.
 *
 * Hex rather than the canonical `sha256/<base64url>` form because that is what
 * the gatekeeper prints, what its config file records and what the browser
 * extension shows; a digest copied here is one that can be pasted straight into
 * `gatekeeper endpoint trust add` and compared against a verification report by
 * eye (SUP-115).
 */
export function DigestValue({ hex, canonical, copyLabel, keep = 6 }: DigestValueProps) {
  const shown = formatDigest(hex, canonical);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span title={shown}>{shortenDigest(shown, keep)}</span>
      {copyLabel ? <CopyButton value={shown} label={copyLabel} /> : null}
    </span>
  );
}
