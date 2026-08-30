import { createHmac, timingSafeEqual } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';

/**
 * Short-lived signed links, for the two things GraphQL cannot deliver: a binary
 * download and a redirect back from a payment page.
 *
 * They are deliberately *not* session cookies. An evidence bundle is exported so
 * it can be handed to an auditor, and a payment redirect arrives from another
 * origin — in both cases the URL itself has to carry the authority, bounded by
 * an expiry, rather than depending on whoever's browser opens it.
 *
 * The secret is `auth.secret`, which already signs sessions and magic links;
 * rotating it invalidates outstanding links, which is the correct behaviour.
 */

/** What every link carries: what it is for, and until when. */
export interface SignedLinkClaims {
  aud: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

export type LinkPayload = Record<string, string | number | boolean | null> & { aud: string };

export interface SignOptions {
  ttlMs: number;
  now?: number;
}

export interface VerifyOptions {
  /** A token minted for another audience is refused, however valid its signature. */
  audience: string;
  now?: number;
}

export function signLink(secret: string, claims: LinkPayload, options: SignOptions): string {
  const now = options.now ?? Date.now();
  const body = Buffer.from(JSON.stringify({ ...claims, exp: now + options.ttlMs }), 'utf8').toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

export function verifyLink<T extends SignedLinkClaims>(secret: string, token: string, options: VerifyOptions): T {
  const [body, signature] = token.split('.');
  if (!body || !signature || !matches(sign(secret, body), signature)) {
    throw new UnauthorizedException('This link is not valid.');
  }

  let claims: T;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    throw new UnauthorizedException('This link is not valid.');
  }

  if (claims.aud !== options.audience) {
    throw new UnauthorizedException('This link is not valid.');
  }
  if (typeof claims.exp !== 'number' || claims.exp <= (options.now ?? Date.now())) {
    throw new UnauthorizedException('This link has expired.');
  }
  return claims;
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/** Constant-time comparison, so a signature cannot be found one byte at a time. */
function matches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
