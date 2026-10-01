'use client';

import { Button } from '@confidential-router/ui/components/button';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import { Gift, TriangleAlert } from 'lucide-react';
import * as React from 'react';
import { formatUsdShort } from '../../lib/format';
import { type InviteLookup, lookupInvite } from '../../lib/invite-lookup';
import { INVITE_REFUSAL_COPY, type InviteRefusalCode } from '../../lib/invite-refusal';

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
  /**
   * The deployment is invite-only (`signInOptions.inviteRequired`, SUP-173).
   *
   * Changes what the same three states mean rather than adding a fourth: without
   * a usable code there is no account to be had, so the input is always open and
   * every unusable code is an alert instead of a footnote about credit.
   */
  required?: boolean;
  /**
   * A refusal the router has already made, from a sign-up that was attempted and
   * turned away — the race the live lookup cannot see, and the OAuth round trip
   * that lost its cookie. Outranks {@link state}, which is a snapshot from
   * before the attempt.
   */
  refusal?: InviteRefusalCode | null;
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
export function InviteNotice({
  state,
  onCodeEntered,
  required = false,
  refusal = null,
}: InviteNoticeProps): React.ReactElement | null {
  // Open by default where the code we have is no good: the viewer has something to
  // do about it, and hiding the input behind a click helps nobody. On an
  // invite-only deployment it is open from the start — there is nothing else on
  // the screen that can produce an account.
  const [entering, setEntering] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const failed = state.kind === 'unavailable' || state.kind === 'unknown';
  const showsInput = entering || failed || required;

  const apply = (): void => {
    const code = typed.trim();
    if (code.length > 0) {
      onCodeEntered(code);
    }
  };

  /**
   * The way back in for someone whose code is no good, or who never had one on
   * the page. Shared by the refusal above and the states below, because it is
   * the same field wherever it appears.
   */
  const codeInput = (): React.ReactElement =>
    showsInput ? (
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
    );

  // Whatever the lookup last said, a refusal the router actually made is newer
  // and is the thing to explain: it is the outcome of an attempt, not of a check.
  if (refusal) {
    const { title, detail } = INVITE_REFUSAL_COPY[refusal];
    return (
      <div className="flex flex-col gap-2">
        <div
          className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3"
          role="alert"
          data-testid={`invite-refused-${refusal}`}
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-medium text-sm">{title}</p>
            <p className="text-muted-foreground text-xs leading-relaxed">{detail}</p>
          </div>
        </div>
        {codeInput()}
      </div>
    );
  }

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

      {/* On an invite-only deployment the same answer means something else: the
          code is not worth less credit, it is the difference between having an
          account and not. So it is an alert rather than a footnote saying to
          carry on.

          It does not guess which refusal it is, and that is the whole of
          SUP-176. The public lookup collapses claimed, expired, withdrawn and
          never-issued into one `unavailable` on purpose, so this sentence has no
          way to know — and the old copy filled the gap with "it may already have
          been claimed", which told the one visitor whose link really was spent
          that they had probably mistyped it. The router does know and answers a
          typed refusal to the submit, which is why the sign-up is no longer held
          behind this state: the sentence below sends the visitor to get the
          answer instead of inventing it. */}
      {state.kind === 'unavailable' ? (
        required ? (
          <div
            className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3"
            role="alert"
            data-testid="invite-unavailable-required"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-medium text-sm">This invitation cannot be used.</p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Submit the form to find out whether it was already claimed or was never issued — nothing is created by
                asking. You can also paste a different code below.
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm" role="status" data-testid="invite-unavailable">
            This invitation cannot be used any more — it may have been claimed already or expired.{' '}
            <span className="text-muted-foreground">
              You can still create an account; it just starts without the credit.
            </span>
          </p>
        )
      ) : null}

      {state.kind === 'unknown' ? (
        <p className="text-sm" role="status" data-testid="invite-unknown">
          We could not check your invitation just now.{' '}
          <span className="text-muted-foreground">
            {required
              ? 'Registration here is by invitation, so the code has to be checked before an account can be created. Try again in a moment.'
              : 'Sign up anyway — the credit is applied when the account is created, not here.'}
          </span>
        </p>
      ) : null}

      {/* Nothing has happened yet and nothing is wrong, but on an invite-only
          deployment the visitor still has to be told why there is a code field
          above the form at all. */}
      {required && state.kind === 'none' ? (
        <p className="text-sm" data-testid="invite-required-notice">
          Registration is by invitation.{' '}
          <span className="text-muted-foreground">
            Paste the code from the link you were sent — the account cannot be created without it.
          </span>
        </p>
      ) : null}

      {codeInput()}
    </div>
  );
}
