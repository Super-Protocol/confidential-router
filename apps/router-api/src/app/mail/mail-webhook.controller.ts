import {
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { RateLimiter } from '../api/v1/rate-limiter.js';
import { routerConfig } from '../config.js';
import { MailDeliveryService } from './mail-delivery.service.js';
import { MAIL_RATE_LIMITER } from './mail-rate-limiter.js';
import { resolveMailSettings } from './mail-settings.js';
import {
  parseResendDelivery,
  SVIX_ID_HEADER,
  SVIX_SIGNATURE_HEADER,
  SVIX_TIMESTAMP_HEADER,
  type SvixHeaders,
  verifyResendSignature,
} from './resend-webhook.js';

/** Where the mail provider posts. `bootstrap.ts` keeps the raw body for it. */
export const RESEND_WEBHOOK_PATH = '/v1/webhooks/resend';

/** A delivery this deployment did not authenticate. One message for every reason. */
export class MailWebhookSignatureError extends HttpException {
  constructor() {
    super('The webhook delivery could not be verified.', HttpStatus.UNAUTHORIZED);
    this.name = 'MailWebhookSignatureError';
  }
}

/** Too many deliveries from one address. */
export class MailWebhookRateLimitedError extends HttpException {
  constructor() {
    super('Too many webhook deliveries. Try again shortly.', HttpStatus.TOO_MANY_REQUESTS);
    this.name = 'MailWebhookRateLimitedError';
  }
}

/**
 * The mail provider's callback: what happened to a message after the relay
 * accepted it (SUP-551).
 *
 * Authenticated by the provider's HMAC over the raw bytes and by nothing else
 * — no session, no API key — which is why this route is outside every guard
 * and why `bootstrap.ts` must hand it the body before anything reparses it.
 *
 * Like `GET /v1/invites/:code` and the feedback webhook, it lives under `/v1`
 * without being OpenAI-compatible or key-authenticated: that prefix is what
 * the chart's Ingress publishes, and a webhook the provider cannot reach is
 * the same silence this issue is about. (`/health` is not published, which is
 * exactly why the operator-visible half of this feature is on `/admin/health`
 * as well.) It is therefore registered before `V1FallbackController`, which
 * claims everything else under that prefix.
 */
@ApiTags('mail')
@Controller('v1/webhooks')
export class MailWebhookController {
  constructor(
    private readonly deliveries: MailDeliveryService,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @Inject(MAIL_RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  @Post('resend')
  // Always 200 once the delivery is authenticated, whatever it decided: a
  // provider that does not read a 2xx redelivers for days.
  @HttpCode(200)
  @ApiOperation({ summary: 'Mail provider events: records addresses whose mail is being dropped.' })
  async resend(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<{ recorded: number }> {
    // Read off the request rather than through three `@Headers()` parameters:
    // they travel together, they are the provider's one credential, and
    // `verifyResendSignature` takes them as one value.
    const headers = svixHeadersOf(request);
    const secret = resolveMailSettings(this.config).webhookSecret;
    // A hard 404 where no secret is configured, like the feedback webhook: an
    // endpoint that answered would tell a prober which provider we send
    // through and that its deliveries are worth forging.
    if (!secret) {
      throw new NotFoundException();
    }
    await this.admit(response);

    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from(JSON.stringify(request.body ?? {}), 'utf8');
    if (!verifyResendSignature({ secret, rawBody: raw, headers })) {
      throw new MailWebhookSignatureError();
    }

    const events = parseResendDelivery(raw);
    for (const event of events) {
      await this.deliveries.record(event, headers.id ?? '');
    }
    return { recorded: events.length };
  }

  /**
   * Charges one delivery against the caller's minute budget.
   *
   * The signature is the authority, not this. The budget exists so that an
   * unsigned flood cannot spend the service's time verifying HMACs, and it is
   * generous enough that a real provider's retries never reach it.
   */
  private async admit(response: Response): Promise<void> {
    const ip = response.req.ip ?? 'unknown';
    const decision = await this.limiter.consume(`mail-webhook:ip:${ip}`, {
      cost: 1,
      limitPerMinute: this.config.mail.webhooksPerMinute,
    });
    if (!decision.allowed) {
      response.setHeader('Retry-After', String(decision.retryAfterSeconds));
      throw new MailWebhookRateLimitedError();
    }
  }
}

/** The provider's three signing headers, as one value. */
function svixHeadersOf(request: Request): SvixHeaders {
  return {
    id: headerOf(request, SVIX_ID_HEADER),
    timestamp: headerOf(request, SVIX_TIMESTAMP_HEADER),
    signature: headerOf(request, SVIX_SIGNATURE_HEADER),
  };
}

function headerOf(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
