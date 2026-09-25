import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../config.js';
import type { FeedbackRefusalReason, FeedbackSubmission } from '../db/entities/feedback-submission.entity.js';
import { FeedbackSignatureError } from './feedback.errors.js';
import { type FeedbackEligibility, FeedbackEligibilityService } from './feedback-eligibility.service.js';
import { type FeedbackDeliveryOutcome, FeedbackGrantRecorder } from './feedback-grant.recorder.js';
import { issueFeedbackToken, verifyFeedbackToken } from './feedback-token.js';
import {
  FEEDBACK_TOKEN_FIELD,
  type FeedbackDelivery,
  parseTypeformDelivery,
  verifyTypeformSignature,
} from './typeform.js';

/** What the console needs to decide whether, and how, to ask for feedback. */
export interface FeedbackOffer {
  eligibility: FeedbackEligibility;
  /** The form with its hidden fields filled in. Present only when eligible. */
  formUrl: string | null;
  /** The grant this account already took, if it took one. */
  granted: FeedbackSubmission | null;
}

/**
 * The second $100, earned by telling us how the first one went.
 *
 * Two halves, and the seam between them is the point. The console asks for an
 * {@link FeedbackOffer} on a session, and gets a URL carrying a signed statement
 * that this account asked for the form. The form provider posts the submission
 * back, and the account credited is the one that statement names — never one
 * named by the payload, because the form is public and anything a public form
 * can say is something anyone can make it say.
 *
 * What is decided lives here; what is written lives in `FeedbackGrantRecorder`.
 */
@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    private readonly eligibility: FeedbackEligibilityService,
    private readonly recorder: FeedbackGrantRecorder,
  ) {}

  /** Whether the webhook is accepting anything at all on this deployment. */
  get configured(): boolean {
    return this.config.feedback.form !== undefined;
  }

  /** What a completed form is worth here, whoever is asking. */
  get grantMicros(): number {
    return this.config.feedback.grantMicros;
  }

  /**
   * What to show this account, and where to send it.
   *
   * The token is minted here and only here, and only for an account that is
   * eligible right now. That is what makes the eligibility decision a backend
   * one even though the form belongs to a third party: the browser cannot mint a
   * token, and a token is the only thing the webhook believes.
   */
  async offerFor(userId: string): Promise<FeedbackOffer> {
    const eligibility = await this.eligibility.evaluate(userId);
    const granted = await this.eligibility.grantOf(userId);
    if (!eligibility.eligible) {
      return { eligibility, formUrl: null, granted };
    }
    return { eligibility, formUrl: this.formUrlFor({ userId, workspaceId: eligibility.workspaceId }), granted };
  }

  /**
   * One webhook delivery: verified, recorded, and credited if it has earned it.
   *
   * Throws only when the delivery is not ours — a bad provider signature, or a
   * missing, forged or stale token. Everything past that answers with an outcome
   * and a 200, because a provider that does not read a 2xx redelivers for days,
   * and a submission we have decided about is not one we want to be told about
   * again.
   */
  async handleDelivery(rawBody: Buffer, signature: string | undefined): Promise<FeedbackDeliveryOutcome> {
    const form = this.config.feedback.form;
    if (!form || !verifyTypeformSignature(form.webhookSecret, rawBody, signature)) {
      throw new FeedbackSignatureError();
    }

    const delivery = parseTypeformDelivery(rawBody);
    if (!delivery) {
      return { status: 'ignored' };
    }

    const verification = verifyFeedbackToken(this.config.auth.secret, delivery.token ?? '', {
      ttlMs: this.config.feedback.tokenTtl,
    });
    if (!verification.valid) {
      // The provider is who it says it is; the submission still identifies
      // nobody we can credit. It buys nothing and is filed against no account.
      this.logger.warn(
        `Feedback submission ${delivery.submissionId} carried no usable token (${verification.failure}).`,
      );
      throw new FeedbackSignatureError();
    }

    return this.settle(delivery, verification.claims.userId, verification.claims.workspaceId);
  }

  /**
   * The form URL with the hidden fields filled in.
   *
   * `t` rather than a user id: a raw id in a public form's URL is an invitation
   * to credit a stranger's account by typing theirs instead.
   */
  private formUrlFor(claims: { userId: string; workspaceId: string }): string | null {
    const form = this.config.feedback.form;
    if (!form) {
      return null;
    }
    const url = new URL(form.url);
    url.searchParams.set(
      FEEDBACK_TOKEN_FIELD,
      issueFeedbackToken(this.config.auth.secret, { ...claims, issuedAt: Date.now() }),
    );
    return url.toString();
  }

  private async settle(
    delivery: FeedbackDelivery,
    userId: string,
    workspaceId: string,
  ): Promise<FeedbackDeliveryOutcome> {
    if (await this.recorder.settled(delivery.submissionId)) {
      return { status: 'replayed' };
    }

    const provider = this.config.feedback.form?.provider ?? 'typeform';
    const refusal = await this.refusalFor(userId, workspaceId);
    if (refusal) {
      return this.recorder.refuse({
        delivery,
        userId,
        workspaceId,
        provider,
        reason: refusal,
        // `unknown_account` is the one refusal that keeps nothing: the token
        // names a workspace this account never had a grant in, so there is no
        // row the submission could be filed against — and inventing one would
        // mean writing a foreign key to a workspace that may not exist.
        store: refusal !== 'unknown_account',
      });
    }

    return this.recorder.grant({
      delivery,
      userId,
      workspaceId,
      provider,
      grantMicros: this.config.feedback.grantMicros,
    });
  }

  /**
   * Why this submission cannot be credited, or `null`.
   *
   * The balance test is deliberately skipped: the account passed it when the
   * console minted its token, and someone who topped up while writing their
   * answers has not stopped deserving the grant they were promised for writing
   * them.
   */
  private async refusalFor(userId: string, workspaceId: string): Promise<FeedbackRefusalReason | null> {
    const eligibility = await this.eligibility.evaluate(userId, { ignoreBalance: true });
    if (eligibility.workspaceId === null) {
      // No first grant to report on, or no form on this deployment at all.
      return 'not_eligible';
    }
    // The token names a workspace; eligibility names the one the first grant
    // landed in. A token that disagrees is not one this deployment minted for
    // this account, whatever its signature says about who wrote it.
    if (eligibility.workspaceId !== workspaceId) {
      return 'unknown_account';
    }
    if (eligibility.eligible) {
      return null;
    }
    return eligibility.reason === 'already_granted' ? 'already_granted' : 'not_eligible';
  }
}
