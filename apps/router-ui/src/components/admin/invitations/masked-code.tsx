'use client';

import { Button } from '@confidential-router/ui/components/button';
import { CopyButton } from '@confidential-router/ui/components/copy-button';
import { Eye, EyeOff } from 'lucide-react';
import * as React from 'react';
import { maskCode } from './invitations';

/**
 * An invitation code, masked until an operator asks to see it (SUP-268).
 *
 * A code is a bearer grant of real credit, and the lists it appears in are
 * exactly the screens that get shared and screenshotted. So the default is the
 * first group only; revealing is one click and per row, and copying never needs
 * the reveal — the clipboard gets the whole code either way.
 */
export function MaskedCode({ code }: { code: string }) {
  const [revealed, setRevealed] = React.useState(false);
  const masked = maskCode(code);

  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="font-mono text-xs" data-testid="invite-code">
        {revealed ? code : masked}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => setRevealed((value) => !value)}
        aria-label={revealed ? `Hide code ${masked}` : `Reveal code ${masked}`}
        aria-pressed={revealed}
      >
        {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </Button>
      <CopyButton value={code} label={`Copy code ${masked}`} className="size-7" />
    </span>
  );
}
