import { UseGuards } from '@nestjs/common';
import { Query, Resolver } from '@nestjs/graphql';
import { CurrentUser, SessionGuard, type SessionUser } from '../../../auth/index.js';
import type { FeedbackIneligibleReason } from '../../../feedback/index.js';
import { FeedbackService } from '../../../feedback/index.js';
import { FeedbackIneligibleReasonEnum, FeedbackOfferModel } from './feedback.model.js';

const REASONS: Record<FeedbackIneligibleReason, FeedbackIneligibleReasonEnum> = {
  disabled: FeedbackIneligibleReasonEnum.DISABLED,
  no_first_grant: FeedbackIneligibleReasonEnum.NO_FIRST_GRANT,
  already_granted: FeedbackIneligibleReasonEnum.ALREADY_GRANTED,
  balance_healthy: FeedbackIneligibleReasonEnum.BALANCE_HEALTHY,
  no_usage: FeedbackIneligibleReasonEnum.NO_USAGE,
};

/**
 * The second grant, in the console.
 *
 * One query and no mutation, for the same reason `InvitesResolver` has none: the
 * grant is applied by a signed webhook and nowhere else, so a field that could
 * apply it would be a field that could apply it twice. What the console can do
 * is ask whether to make the offer — and get, in the same answer, the URL to
 * make it with.
 *
 * Reading this query mints a token, which is why it is behind `SessionGuard`
 * and takes no arguments: the account is the session's, never the caller's to
 * name.
 */
@Resolver()
export class FeedbackResolver {
  constructor(private readonly feedback: FeedbackService) {}

  @Query(() => FeedbackOfferModel, {
    description: 'Whether to offer the viewer a second grant for feedback, and the form link to do it with.',
  })
  @UseGuards(SessionGuard)
  async feedbackOffer(@CurrentUser() user: SessionUser): Promise<FeedbackOfferModel> {
    const offer = await this.feedback.offerFor(user.id);
    return {
      eligible: offer.eligibility.eligible,
      reason: offer.eligibility.eligible ? null : REASONS[offer.eligibility.reason],
      grantMicros: String(offer.eligibility.eligible ? offer.eligibility.grantMicros : this.feedback.grantMicros),
      formUrl: offer.formUrl,
      granted:
        offer.granted && offer.granted.creditTransactionId
          ? {
              creditTransactionId: offer.granted.creditTransactionId,
              grantMicros: String(offer.granted.grantMicros ?? 0),
              appliedAt: offer.granted.createdAt,
            }
          : null,
    };
  }
}
