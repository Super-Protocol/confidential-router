'use client';

import { Button } from '@confidential-router/ui/components/button';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import { Gift } from 'lucide-react';
import * as React from 'react';
import { formatUsdShort } from '../../lib/format';
import { type InviteLookup, lookupInvite } from '../../lib/invite-lookup';

export type InviteState =
  /** Nothing to say: no code, and the viewer has not opened the input. */
  | { kind: 'none' }
  | { kind: 'checking' }
  /** Confirmed by the router. `code` is what the sign-up should send. */
  | { kind: 'ready'; code: string; grantMicros: string; campaign: string }
  /** The router says this code cannot be redeemed. It is still sent — see below. */
  | { kind: 'unavailable'; code: string }
  /** The router could not be asked. Not the same as a refusal. */
  | { kind: 'unknown'; code: string };

/**
 * Resolves the code this page load carries into something the form can say.
 *
 * Two deliberate properties. The lookup is advisory — an `unavailable` or
 * `unknown` code is still sent with the sign-up, because the endpoint's answer is
 * a snapshot and only the redemption inside account creation decides anything; and
 * a failed lookup never stops anyone registering, which is the whole shape of this
 * feature (SUP-142).
 */
export function useInviteLookup(code: string | null): InviteState {
  const [state, setState] = React.useState<InviteState>(code ? { kind: 'checking' } : { kind: 'none' });

  React.useEffect(() => {
    if (!code) {
      setState({ kind: 'none' });
      return;
    }
    setState({ kind: 'checking' });
    const controller = new AbortController();

    lookupInvite(code, controller.signal)
      .then((lookup: InviteLookup) => {
        if (controller.signal.aborted) return;
        if (lookup.valid) {
          setState({ kind: 'ready', code, grantMicros: lookup.grantMicros, campaign: lookup.campaign });
        } else {
          setState({ kind: 'unknown' in lookup ? 'unknown' : 'unavailable', code });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: 'unknown', code });
      });

    return () => controller.abort();
  }, [code]);

  return state;
}

export interface InviteNoticeProps {
  state: InviteState;
  /**
   * Called with a code the viewer typed, trimmed and non-empty. Normalising is
   * the caller's, so that a typed code and one out of the URL arrive at the
   * lookup in the same shape.
   */
  onCodeEntered: (code: string) => void;
}

/**
 * What the sign-up form says about the invitation, and the way back in for
 * someone who lost the link.
 *
 * The visitor never types a code in the ordinary case: it arrives in the URL and
 * the form only confirms what it is worth. The input exists for the one person who
 * forwarded the mail to their work address and opened the console from a bookmark
 * — a real case, and the alternative for them is silently not getting $100.
 */
export function InviteNotice({ state, onCodeEntered }: InviteNoticeProps): React.ReactElement | null {
  // Open by default where the code we have is no good: the viewer has something to
  // do about it, and hiding the input behind a click helps nobody.
  const [entering, setEntering] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const failed = state.kind === 'unavailable' || state.kind === 'unknown';
  const showsInput = entering || failed;

  const apply = (): void => {
    const code = typed.trim();
    if (code.length > 0) {
      onCodeEntered(code);
    }
  };

  if (state.kind === 'ready') {
    return (
      <div
        className="flex items-start gap-3 rounded-xl border border-brand-border bg-brand-muted px-4 py-3"
        data-testid="invite-grant-pending"
      >
        <Gift className="mt-0.5 size-4 shrink-0 text-brand-emphasis" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-medium text-sm">
            {formatUsdShort(state.grantMicros)} in credits will be added to your account.
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            From the <span className="font-mono">{state.campaign}</span> invitation. It is applied when the account is
            created — there is nothing to redeem.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {state.kind === 'checking' ? (
        <p className="text-muted-foreground text-sm" role="status" data-testid="invite-checking">
          Checking your invitation…
        </p>
      ) : null}

      {state.kind === 'unavailable' ? (
        <p className="text-sm" role="status" data-testid="invite-unavailable">
          This invitation cannot be used any more — it may have been claimed already or expired.{' '}
          <span className="text-muted-foreground">
            You can still create an account; it just starts without the credit.
          </span>
        </p>
      ) : null}

      {state.kind === 'unknown' ? (
        <p className="text-sm" role="status" data-testid="invite-unknown">
          We could not check your invitation just now.{' '}
          <span className="text-muted-foreground">
            Sign up anyway — the credit is applied when the account is created, not here.
          </span>
        </p>
      ) : null}

      {showsInput ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="invite-code">Invitation code</Label>
          <div className="flex gap-2">
            <Input
              id="invite-code"
              name="invite-code"
              // Not `autoComplete="off"`: a code is not a credential and the
              // browser has no field type for it.
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="ABCD-EFGH-JKLM"
              className="font-mono"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                // Enter inside this input must not submit the sign-up form: the
                // viewer is applying a code, not creating the account yet.
                if (event.key === 'Enter') {
                  event.preventDefault();
                  apply();
                }
              }}
            />
            <Button type="button" variant="outline" disabled={typed.trim().length === 0} onClick={apply}>
              Apply
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start px-0 text-muted-foreground"
          aria-expanded={false}
          onClick={() => setEntering(true)}
        >
          Have a code?
        </Button>
      )}
    </div>
  );
}
