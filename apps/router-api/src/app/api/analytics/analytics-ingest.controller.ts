import { randomUUID } from 'node:crypto';
import { isConsoleIngestEventName } from '@confidential-router/types';
import {
  BadRequestException,
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { type AnalyticsPropertyValue, AnalyticsService, ConsoleEventDto, eventUuid } from '../../analytics/index.js';
import { CurrentUser, OptionalSessionGuard, type SessionUser } from '../../auth/index.js';
import { routerConfig } from '../../config.js';
import { RATE_LIMITER, type RateLimiter } from '../v1/rate-limiter.js';
import { AnalyticsRateLimitedError } from './analytics-ingest.errors.js';

/**
 * The events the browser may assert, and whether each one names an account.
 *
 * `signup_started` is anonymous on purpose, and would stay anonymous even for a
 * visitor who happened to hold a session: identifying it would need a value
 * stored in their browser to stitch it to the account that appears later, which
 * is the thing ADR-006 §4 rules out. `feedback_form_opened` is the opposite — it
 * can only happen inside the console, so it rides the session and the form
 * provider needs no identifier of ours in its URL (SUP-149).
 */
const IDENTIFIED: Record<string, boolean> = {
  signup_started: false,
  feedback_form_opened: true,
};

/** Longest property value accepted. A closed value set needs far less; free text needs more. */
const MAX_VALUE_LENGTH = 128;

/** Most properties any event in the taxonomy declares is six. */
const MAX_PROPERTIES = 12;

/**
 * The console's first-party analytics ingest.
 *
 * It exists so that the console makes no third-party request. `posthog-js` in
 * the bundle would have bought two events and written a persistent identifier to
 * the visitor's device — which is what ePrivacy Art. 5(3) attaches consent to,
 * and a consent banner in front of the launch campaign costs more than two
 * events are worth (ADR-006 §3). The other six console events are facts
 * router-api commits to the database anyway, and are captured server-side.
 *
 * Everything a client could lie about is the server's: `distinct_id`, the
 * timestamp and the event `uuid`. What is left — an event name and a handful of
 * properties — is checked against the taxonomy, which is what keeps a public
 * endpoint from being a way to write arbitrary rows into our analytics.
 *
 * It answers 202 with an empty body. There is nothing for the console to do with
 * a result, and a caller that waited for one would be waiting on PostHog.
 */
@ApiTags('analytics')
@Controller('v1/analytics')
export class AnalyticsIngestController {
  constructor(
    private readonly analytics: AnalyticsService,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  @Post('events')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @UseGuards(OptionalSessionGuard)
  @ApiOperation({ summary: 'Records one console event. Anonymous for a visitor who has no account yet.' })
  async record(
    @Body() body: ConsoleEventDto,
    @CurrentUser() user: SessionUser | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.admit(response);

    const event = body?.event;
    if (!isConsoleIngestEventName(event)) {
      // Named rather than generic: the console and this list are two
      // implementations of one taxonomy, so a rejection here is a bug in one of
      // them rather than a visitor's mistake, and it has to be readable in a
      // browser console.
      throw new BadRequestException(`"${String(event)}" is not an event the console may post.`);
    }

    const identified = IDENTIFIED[event] ?? true;
    if (identified && !user) {
      throw new UnauthorizedException(`${event} is recorded against an account, and this request carries no session.`);
    }

    await this.analytics.capture({
      event,
      distinctId: identified ? (user?.id ?? null) : null,
      // Random, because neither ingest event reports a database row: two
      // visitors opening the sign-up screen are two events, and there is nothing
      // for a retry to be idempotent against. The taxonomy's idempotency rule
      // applies to the server-side events, which do report a row.
      uuid: eventUuid(event, randomUUID()),
      properties: scalars(body?.properties),
    });
  }

  /**
   * Charges one event against the caller's minute budget.
   *
   * Its own budget rather than `/v1`'s: a tenant's generation traffic and the
   * console's instrumentation must not spend each other's, the same split
   * `InvitesController` makes. Generous next to the lookup budget, because one
   * visitor legitimately produces several events a minute, and cheap to refuse
   * because nothing downstream has happened yet.
   */
  private async admit(response: Response): Promise<void> {
    const ip = response.req.ip ?? 'unknown';
    const decision = await this.limiter.consume(`analytics:ip:${ip}`, {
      cost: 1,
      limitPerMinute: this.config.analytics.ingestPerMinute,
    });
    if (!decision.allowed) {
      response.setHeader('Retry-After', String(decision.retryAfterSeconds));
      throw new AnalyticsRateLimitedError();
    }
  }
}

/**
 * The body's properties, minus anything that is not a short scalar.
 *
 * `AnalyticsService` decides which *names* are allowed; this is about the values.
 * A nested object or an array cannot be broken down on in PostHog and is how
 * free text gets in by accident (`analytics-events.md`, convention 4); a
 * non-finite number serialises to `null`, which "absent, never null" exists to
 * keep out; and a long string is free text whatever the property is called.
 */
function scalars(properties: Record<string, unknown> | undefined): Record<string, AnalyticsPropertyValue> {
  const clean: Record<string, AnalyticsPropertyValue> = {};
  for (const [key, value] of Object.entries(properties ?? {}).slice(0, MAX_PROPERTIES)) {
    if (typeof value === 'string' && value.length <= MAX_VALUE_LENGTH) {
      clean[key] = value;
    } else if (typeof value === 'boolean') {
      clean[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      clean[key] = value;
    }
  }
  return clean;
}
