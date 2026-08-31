import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../../config.js';
import type { ApiKey } from '../../db/entities/api-key.entity.js';
import { openAiErrors } from './openai-error.js';
import { RATE_LIMITER, type RateLimitDecision, type RateLimiter } from './rate-limiter.js';

/** `X-RateLimit-*` values for the tightest bucket the request touched. */
export type RateLimitHeaders = Record<string, string>;

export interface RateLimitGrant {
  headers: RateLimitHeaders;
}

/**
 * Applies the two budgets `/v1` enforces: requests per minute and tokens per
 * minute, each at two scopes — four buckets, all four consulted on admission.
 *
 * The key's own settings win where they are set, and the config's
 * `rateLimits.*` are the workspace default (`router-api.md` §Errors). The
 * workspace bucket exists as well as the key bucket so that minting ten keys
 * does not multiply a tenant's budget by ten.
 */
@Injectable()
export class RateLimitService {
  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  /** Charges one request against both scopes, or throws the contract's 429. */
  async admit(key: ApiKey): Promise<RateLimitGrant> {
    const perKey = key.requestsPerMinute ?? this.config.rateLimits.requestsPerMinute;
    const perWorkspace = this.config.rateLimits.requestsPerMinute;

    const keyDecision = await this.limiter.consume(`req:key:${key.id}`, { cost: 1, limitPerMinute: perKey });
    if (!keyDecision.allowed) {
      throw rateLimited('API key', keyDecision);
    }
    const workspaceDecision = await this.limiter.consume(`req:ws:${key.workspaceId}`, {
      cost: 1,
      limitPerMinute: perWorkspace,
    });
    if (!workspaceDecision.allowed) {
      throw rateLimited('workspace', workspaceDecision);
    }

    // The token buckets are only *checked* here: the cost is unknown until the
    // model answers. A key — or a workspace — whose token budget is already
    // exhausted is refused before a single byte is forwarded. Both scopes are
    // checked for the same reason the request buckets are: `settle` debits both,
    // so a bucket that is never consulted is a budget that can never refuse.
    const keyTokens = await this.limiter.consume(`tok:key:${key.id}`, {
      cost: 0,
      limitPerMinute: this.tokenLimitFor(key),
    });
    if (keyTokens.remaining <= 0) {
      throw rateLimited('API key token', { ...keyTokens, allowed: false });
    }
    const workspaceTokens = await this.limiter.consume(`tok:ws:${key.workspaceId}`, {
      cost: 0,
      limitPerMinute: this.config.rateLimits.tokensPerMinute,
    });
    if (workspaceTokens.remaining <= 0) {
      throw rateLimited('workspace token', { ...workspaceTokens, allowed: false });
    }

    return { headers: headersFor(tighter(keyDecision, workspaceDecision)) };
  }

  /** Settles the tokens a finished generation actually used. */
  async settle(key: ApiKey, totalTokens: number): Promise<void> {
    if (totalTokens <= 0) {
      return;
    }
    await this.limiter.debit(`tok:key:${key.id}`, { cost: totalTokens, limitPerMinute: this.tokenLimitFor(key) });
    await this.limiter.debit(`tok:ws:${key.workspaceId}`, {
      cost: totalTokens,
      limitPerMinute: this.config.rateLimits.tokensPerMinute,
    });
  }

  private tokenLimitFor(key: ApiKey): number {
    return key.tokensPerMinute ?? this.config.rateLimits.tokensPerMinute;
  }
}

function tighter(first: RateLimitDecision, second: RateLimitDecision): RateLimitDecision {
  return first.remaining <= second.remaining ? first : second;
}

function headersFor(decision: RateLimitDecision): RateLimitHeaders {
  return {
    'X-RateLimit-Limit': String(decision.limit),
    'X-RateLimit-Remaining': String(decision.remaining),
    'X-RateLimit-Reset': String(Math.ceil(decision.resetAt / 1000)),
  };
}

function rateLimited(scope: string, decision: RateLimitDecision) {
  return openAiErrors.rateLimited(`Rate limit exceeded for this ${scope}.`, {
    ...headersFor(decision),
    'Retry-After': String(decision.retryAfterSeconds),
  });
}
