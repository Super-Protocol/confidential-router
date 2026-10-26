'use client';

import { useQuery } from '@apollo/client/react';
import { Button } from '@confidential-router/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader } from '@confidential-router/ui/components/card';
import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import { MailCheck } from 'lucide-react';
import * as React from 'react';
import { AuthRequestError } from '../../lib/auth';
import { messageOf } from './messages';
import { SIGN_IN_MAIL_STATE_QUERY } from './operations';

/**
 * What the router can say about the two email-code requests that is not about
 * what was typed: 429 is its per-source budget on asking for a code and on
 * trying one, and 404 is a deployment with no mailer, which does not register
 * the routes at all.
 */
const EMAIL_CODE_MESSAGES = {
  404: 'Sign-in by emailed code is not available on this deployment.',
  429: 'Too many attempts. Wait a minute and try again.',
};

/**
 * A code that is dead whatever is typed next: it expired (`OTP_EXPIRED`), or it
 * was guessed at too often (`TOO_MANY_ATTEMPTS`). The only way forward from
 * either is a new code, so the two share a sentence.
 */
const SPENT_CODES: readonly string[] = ['OTP_EXPIRED', 'TOO_MANY_ATTEMPTS'];

/** What to say when asking for a code failed. */
export function codeRequestMessageOf(error: unknown): string {
  return messageOf(error, EMAIL_CODE_MESSAGES);
}

/**
 * What to say when a code was refused, and whether typing another guess can
 * help.
 *
 * Told apart by Better Auth's `code` and not by the status, because all three
 * refusals are a 400. `spent` is what the screen clears the field on: leaving a
 * dead code in it invites pressing the button again.
 */
export function codeFailureOf(error: unknown): { message: string; spent: boolean } {
  const code = error instanceof AuthRequestError ? error.code : undefined;
  if (code === 'INVALID_OTP') {
    // Also what the router answers for a code that was already used: it keeps
    // no record of one once it has signed somebody in. Hence the second half.
    return { message: 'That code is not right. Check the mail and try again, or send a new one.', spent: false };
  }
  if (code !== undefined && SPENT_CODES.includes(code)) {
    return { message: 'That code no longer works. Send a new one.', spent: true };
  }
  return { message: messageOf(error, EMAIL_CODE_MESSAGES), spent: false };
}

export interface EmailCodeStepProps {
  /** The address the code was mailed to, shown back so a typo is visible. */
  email: string;
  /** Digits in a code — the router's (`signInOptions.emailCodeLength`). */
  length: number;
  /** The verb on the primary button, and what it reads while the request is out. */
  submitLabel: string;
  submittingLabel: string;
  /** Which of this step's two requests is in flight, if either. */
  pending: 'verify' | 'resend' | null;
  error: string | null;
  /** A new code was mailed from this step, said so once it has been. */
  resent: boolean;
  onSubmit: (code: string) => void;
  onResend: () => void;
  onChangeAddress: () => void;
}

/**
 * The second half of signing in by mail: the code comes back.
 *
 * Shared by the sign-in and the sign-up screen because it is the same request
 * either way — the router creates the account when an address it has not seen
 * hands back a good code — and so the copy here never says which of the two is
 * about to happen. It cannot know: the router mails a code to any address and
 * does not say whether an account was behind it.
 *
 * The field's contents live here and nowhere else. A caller that wants it
 * emptied — the code was refused as spent, or a new one replaced it — remounts
 * this with a new `key`, so a dead code is never left sitting above the button.
 */
/**
 * Whether this deployment's provider is dropping mail to the address.
 *
 * Asked here rather than passed in: both screens that mount this step would
 * otherwise have to carry a query neither of them reads, and the address this
 * is about is the one prop this component already has. A failed or refused
 * lookup is `false` — the honest line is an *addition* to the screen, and
 * losing it costs the copy that was there before and nothing else.
 */
function useAddressRejected(email: string): boolean {
  const { data } = useQuery(SIGN_IN_MAIL_STATE_QUERY, {
    variables: { email },
    skip: email.length === 0,
    fetchPolicy: 'network-only',
  });
  return data?.signInMailState.state === 'REJECTING';
}

export function EmailCodeStep({
  email,
  length,
  submitLabel,
  submittingLabel,
  pending,
  error,
  resent,
  onSubmit,
  onResend,
  onChangeAddress,
}: EmailCodeStepProps) {
  const [code, setCode] = React.useState('');
  const rejected = useAddressRejected(email);

  const input = React.useRef<HTMLInputElement>(null);

  // The step replaced the form the viewer was typing in, so focus went with the
  // button they pressed; the code is the only thing left to type.
  React.useEffect(() => {
    input.current?.focus();
  }, []);

  /** Digits only, and no more than a code has: a mail client's stray space is not a wrong code. */
  const accept = (raw: string): void => setCode(raw.replace(/\D/g, '').slice(0, length));

  return (
    <Card>
      <CardHeader>
        <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-brand-muted text-brand-emphasis">
          <MailCheck className="size-4" aria-hidden="true" />
        </div>
        <h1 className="font-semibold leading-none">Enter your code</h1>
        <CardDescription>
          {/* No number of minutes: the lifetime is the deployment's
              (`auth.emailCode.ttl`) and the mail states it exactly. */}
          We sent a {length}-digit code to <span className="font-medium text-foreground">{email}</span>. It works once
          and expires in a few minutes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(code);
          }}
        >
          <Label htmlFor="email-code">Code</Label>
          <Input
            id="email-code"
            name="code"
            type="text"
            inputMode="numeric"
            // What lets a phone offer the code straight from the mail or the
            // message it arrived in.
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={length}
            required
            ref={input}
            className="font-mono tracking-widest"
            value={code}
            onChange={(event) => accept(event.target.value)}
            onPaste={(event) => {
              // `maxLength` truncates a paste before `onChange` sees it, so
              // "123 456" would arrive as five digits and a space.
              event.preventDefault();
              accept(event.clipboardData.getData('text'));
            }}
            aria-describedby={error ? 'email-code-error' : undefined}
            aria-invalid={error !== null || undefined}
          />
          <Button
            type="submit"
            variant="brand"
            className="w-full"
            disabled={pending !== null || code.length !== length}
          >
            {pending === 'verify' ? submittingLabel : submitLabel}
          </Button>
        </form>

        {error ? (
          <p id="email-code-error" role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        {resent && !error ? (
          <p role="status" className="text-muted-foreground text-sm" data-testid="email-code-resent">
            A new code is on its way. Use the newest one.
          </p>
        ) : null}

        {rejected ? (
          /* The one case where "check spam, it may be slow" is false in every
             clause: the provider has this address on its suppression list, so
             the message was accepted and then discarded, and pressing "Send a
             new code" produces another one that is discarded too (SUP-551).
             Said plainly, and about the address rather than about any account
             — the router still does not say whether one exists. */
          <p role="status" data-testid="email-code-rejected" className="text-destructive text-sm leading-relaxed">
            Mail to this address is being rejected, so the code did not arrive and a new one will not either. Sign in
            with a different address, or ask us to look into this one.
          </p>
        ) : (
          /* The router answers "sent" whatever happened — it mails one address
             only so many codes an hour and says nothing when that runs out, so
             as not to tell a stranger anything about the address. This line is
             what stops that from reading as a broken button. */
          <p className="text-muted-foreground text-xs leading-relaxed">
            Nothing in the inbox? Check spam first. An address is mailed only a limited number of codes an hour, so a
            new one may not arrive straight away.
          </p>
        )}

        <div className="flex flex-col gap-2">
          <Button variant="outline" className="w-full" disabled={pending !== null} onClick={onResend}>
            {pending === 'resend' ? 'Sending…' : 'Send a new code'}
          </Button>
          {/* On an address the provider is dropping, a new code is another
              discarded message and this is the only button that can still
              work — so it leads rather than trails (SUP-551). */}
          <Button
            variant={rejected ? 'brand' : 'ghost'}
            className="w-full"
            disabled={pending !== null}
            onClick={onChangeAddress}
          >
            Use a different address
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
