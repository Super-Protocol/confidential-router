import { Inject, UseGuards } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Query, Resolver } from '@nestjs/graphql';
import { AdminGuard, SessionGuard } from '../../../auth/index.js';
import { routerConfig } from '../../../config.js';
import {
  type MailDeliveryReport,
  type MailFailureReason,
  MailService,
  type MailStatus,
} from '../../../mail/mail.service.js';
import {
  MailDeliveryModel,
  MailFailureReasonEnum,
  MailProviderEnum,
  MailStateEnum,
  MailWithheldModel,
} from './mail-delivery.model.js';

/*
 * The three vocabularies, spelled out rather than upper-cased at runtime. A
 * `toUpperCase()` cast compiles after a new provider is added to the
 * configuration and then fails to serialise a non-null field, which nulls the
 * whole query; these maps make the same change a compile error here instead.
 */
const PROVIDERS = {
  none: MailProviderEnum.NONE,
  console: MailProviderEnum.CONSOLE,
  resend: MailProviderEnum.RESEND,
  smtp: MailProviderEnum.SMTP,
} satisfies Record<MailStatus['provider'], MailProviderEnum>;

const STATES = {
  disabled: MailStateEnum.DISABLED,
  unverified: MailStateEnum.UNVERIFIED,
  ok: MailStateEnum.OK,
  failing: MailStateEnum.FAILING,
} satisfies Record<MailStatus['state'], MailStateEnum>;

const FAILURE_REASONS = {
  unreachable: MailFailureReasonEnum.UNREACHABLE,
  auth_failed: MailFailureReasonEnum.AUTH_FAILED,
  rejected: MailFailureReasonEnum.REJECTED,
  error: MailFailureReasonEnum.ERROR,
} satisfies Record<MailFailureReason, MailFailureReasonEnum>;

/**
 * "The sign-in mail is not arriving" — answered for the deployment's own
 * operator (SUP-462).
 *
 * The question has answers with opposite remedies: it was sent; it was
 * deliberately withheld, for one of three reasons; or the transport is broken.
 * `/health` could only ever distinguish the last, because a withheld send is
 * invisible to the caller by design — and on a published cluster space, where
 * the log cannot be read, that made it invisible to everybody. It cost a false
 * production incident and about a session of two agents hunting an egress fault
 * that did not exist.
 *
 * **Why this is behind `SessionGuard` + `AdminGuard` and not on `/health`.**
 * `withheld` moves by one on each refused request. A caller who can read the
 * count, post an address and read it again learns whether that address was
 * mailed — and on an invite-only deployment that is exactly "does this address
 * have an account", the oracle SUP-410 exists to deny. Aggregate counts are
 * safe for an operator and are not safe for a stranger, so the surface, not the
 * shape, is what keeps them apart. `/health` carries `mail.signUpGate` instead:
 * configuration, which moves for nobody.
 *
 * Read-only and process-local. The counters start at zero on boot and are this
 * replica's own, the same caveat `/health`'s `mail` block has always had.
 */
@Resolver(() => MailDeliveryModel)
@UseGuards(SessionGuard, AdminGuard)
export class MailDeliveryResolver {
  constructor(
    private readonly mail: MailService,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
  ) {}

  @Query(() => MailDeliveryModel, {
    description:
      'Outbound mail: where the transport stands and how much mail was deliberately withheld, by reason. ' +
      'Counted since this replica started. Restricted to auth.adminEmails.',
  })
  mailDelivery(): MailDeliveryModel {
    return this.modelOf(this.mail.delivery());
  }

  private modelOf(report: MailDeliveryReport): MailDeliveryModel {
    const { withheld } = report;
    return {
      provider: PROVIDERS[report.provider],
      state: STATES[report.state],
      reason: report.reason ? FAILURE_REASONS[report.reason] : null,
      since: report.since ? new Date(report.since) : null,
      withheld: withheld
        ? ({
            noInvitation: withheld.noInvitation,
            rateLimited: withheld.rateLimited,
            unusedCodeType: withheld.unusedCodeType,
            lastWithheldAt: new Date(withheld.lastWithheldAt),
          } satisfies MailWithheldModel)
        : null,
      inviteOnly: this.config.auth.requireInviteForSignUp,
    };
  }
}
