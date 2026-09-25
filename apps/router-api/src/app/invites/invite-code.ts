import { randomInt } from 'node:crypto';

/**
 * Minting, normalising and formatting of invitation codes.
 *
 * Pure functions with no Nest and no database, for the same reason
 * `api-key-token.ts` is: this is the part that has to be provably right, and a
 * property of a string is cheaper to test than a property of a service.
 */

/**
 * Thirty characters with no confusable pair left in them: no `0`/`O`, no
 * `1`/`I`/`L`, and no `U` (which turns random strings into words often enough to
 * be worth avoiding on a mailing).
 *
 * Both members of each pair are excluded rather than one being folded onto the
 * other on input. Folding needs a target inside the alphabet — Crockford keeps
 * `0` and maps `O` onto it — and keeping one of a confusable pair is exactly what
 * this alphabet is for not doing. The cost is that a mis-transcribed code is
 * invalid rather than corrected, which is the right trade here: the code travels
 * in the invitation URL and the recipient never types it (SUP-140).
 */
export const INVITE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Characters per group in the display form. */
const GROUP_LENGTH = 4;

/** Groups in a code: `ABCD-EFGH-JKMN`. 30^12 ≈ 5.3 × 10^17, about 59 bits. */
const GROUPS = 3;

export const INVITE_CODE_LENGTH = GROUP_LENGTH * GROUPS;

/** Separators a human or a mail client may have introduced. */
const SEPARATORS = /[\s\-_]+/g;

/**
 * The form that is stored and compared: upper case, no separators.
 *
 * Every lookup goes through here, which is what makes the match
 * case-insensitive as a plain unique-index hit rather than needing `citext` on
 * PostgreSQL and `COLLATE NOCASE` on SQLite — the schema has to be identical on
 * both (`docs/contracts/data-model.md`).
 */
export function normaliseInviteCode(value: string): string {
  return value.trim().replace(SEPARATORS, '').toUpperCase();
}

/** The form an invitation, a CSV and a URL show: `ABCD-EFGH-JKMN`. */
export function formatInviteCode(normalised: string): string {
  const groups: string[] = [];
  for (let at = 0; at < normalised.length; at += GROUP_LENGTH) {
    groups.push(normalised.slice(at, at + GROUP_LENGTH));
  }
  return groups.join('-');
}

/**
 * Cheap shape check, so a lookup for something that cannot be a code is refused
 * before the database is touched. Not an authorisation decision — the service
 * still has to find the row.
 */
export function looksLikeInviteCode(normalised: string): boolean {
  return (
    normalised.length === INVITE_CODE_LENGTH &&
    [...normalised].every((character) => INVITE_CODE_ALPHABET.includes(character))
  );
}

/**
 * One code's worth of entropy, drawn from `crypto.randomInt` rather than
 * `Math.random`: a guessable invitation is a $100 grant handed to whoever
 * guesses it.
 *
 * `randomInt(30)` is rejection-sampled by Node, so the distribution over the
 * alphabet is uniform — `randomBytes[i] % 30` would not be.
 */
export function mintInviteCode(): string {
  let code = '';
  for (let index = 0; index < INVITE_CODE_LENGTH; index += 1) {
    code += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)];
  }
  return code;
}

export interface InviteUrlParts {
  /** Where the landing page is served, e.g. `https://router.superprotocol.com`. */
  landingBaseUrl: string;
  /** The campaign tag, which becomes `utm_campaign`. */
  campaign: string;
  /** Normalised code; the URL carries the display form. */
  code: string;
}

/**
 * The ready-made link a mailing sends: the landing page, the code, and the UTM
 * parameters that let the campaign be measured without a cross-site identifier
 * (SUP-140).
 */
export function inviteUrl({ landingBaseUrl, campaign, code }: InviteUrlParts): string {
  const url = new URL(landingBaseUrl);
  url.searchParams.set('invite', formatInviteCode(code));
  url.searchParams.set('utm_source', 'email');
  url.searchParams.set('utm_medium', 'invite');
  url.searchParams.set('utm_campaign', campaign);
  return url.toString();
}
