import { Controller, Get, Headers, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { BillingService } from './billing.service.js';

/** Where the Stripe webhook is mounted. `bootstrap.ts` keeps the raw body for it. */
export const STRIPE_WEBHOOK_PATH = '/billing/stripe/webhook';

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /**
   * Provider callbacks. Authenticated by the provider's own signature over the
   * raw body and by nothing else — no session, no API key — which is why this
   * route is outside every guard and why the body must not have been reparsed
   * before it gets here.
   */
  @Post('stripe/webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stripe webhook: credits the ledger for confirmed payments.' })
  async stripeWebhook(
    @Req() request: Request,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ applied: number }> {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from(JSON.stringify(request.body ?? {}), 'utf8');
    const applied = await this.billing.handleWebhook(raw, signature);
    return { applied: applied.length };
  }

  /**
   * The manual provider's return link (development and e2e only). The signature
   * in the token is the authority; an unsigned or expired one is refused.
   */
  @Get('manual/complete')
  @ApiExcludeEndpoint()
  async completeManualCheckout(@Query('token') token: string, @Res() response: Response): Promise<void> {
    const { successUrl } = await this.billing.completeManualCheckout(token ?? '');
    response.redirect(303, successUrl);
  }
}
