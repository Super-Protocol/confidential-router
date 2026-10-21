import { Field, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum MailProviderEnum {
  NONE = 'NONE',
  CONSOLE = 'CONSOLE',
  RESEND = 'RESEND',
  SMTP = 'SMTP',
}

registerEnumType(MailProviderEnum, {
  name: 'MailProvider',
  description: 'Which mailer this deployment is configured with.',
});

export enum MailStateEnum {
  DISABLED = 'DISABLED',
  UNVERIFIED = 'UNVERIFIED',
  OK = 'OK',
  FAILING = 'FAILING',
}

registerEnumType(MailStateEnum, {
  name: 'MailState',
  description:
    'Where the transport stands, from the boot-time check or the most recent send, whichever is later. About ' +
    'the transport only: a send the deployment chose not to make leaves this alone.',
});

export enum MailFailureReasonEnum {
  UNREACHABLE = 'UNREACHABLE',
  AUTH_FAILED = 'AUTH_FAILED',
  REJECTED = 'REJECTED',
  ERROR = 'ERROR',
}

registerEnumType(MailFailureReasonEnum, {
  name: 'MailFailureReason',
  description:
    'Why the last attempt failed. `UNREACHABLE`: the connection never reached a mail server at all — DNS, a ' +
    'refused or timed-out connect, a dropped socket.',
});

@ObjectType('MailWithheld', {
  description:
    'Mail this deployment was asked for and deliberately did not send, counted since the process started. ' +
    'Aggregate only and never per address: a queryable list of withheld addresses would rebuild the ' +
    'account-existence oracle the sign-up mail gate exists to deny.',
})
export class MailWithheldModel {
  @Field(() => Int, {
    description:
      'Sign-up mail withheld because this deployment is invite-only and the request carried no invitation it ' +
      'would admit (SUP-410). A non-zero count beside a healthy `state` is the signature of “uninvited ' +
      'addresses asked for a code”, not of an outage.',
  })
  noInvitation!: number;

  @Field(() => Int, {
    description: 'Sign-in codes withheld because that recipient had already had their hourly allowance.',
  })
  rateLimited!: number;

  @Field(() => Int, {
    description:
      'Code requests for a `type` this deployment does not mail — only `sign-in` is, and the flows the other ' +
      'two belong to have their routes disabled. A non-zero count here is a client bug, and it looks exactly ' +
      'like mail that stopped arriving.',
  })
  unusedCodeType!: number;

  @Field({ description: 'When the most recent send was withheld.' })
  since!: Date;
}

@ObjectType('MailDelivery', {
  description:
    'Where outbound mail stands and what was withheld — the operator’s answer to “the sign-in mail is not ' +
    'arriving”, which has three answers with three different remedies: sent, withheld, or the transport is ' +
    'broken. Restricted to auth.adminEmails: every field moves in response to one request, so a caller who ' +
    'could read it before and after naming an address would learn by subtraction whether that address was ' +
    'mailed. The public half is `/health`’s `mail` block.',
})
export class MailDeliveryModel {
  @Field(() => MailProviderEnum)
  provider!: MailProviderEnum;

  @Field(() => MailStateEnum)
  state!: MailStateEnum;

  @Field(() => MailFailureReasonEnum, { nullable: true, description: 'Present only while `state` is `FAILING`.' })
  reason!: MailFailureReasonEnum | null;

  @Field(() => Date, { nullable: true, description: 'When `state` was last established.' })
  since!: Date | null;

  @Field(() => MailWithheldModel, {
    nullable: true,
    description: 'Null until this process has withheld something.',
  })
  withheld!: MailWithheldModel | null;

  @Field({
    description:
      'This deployment is invite-only, so sign-up mail to an address with no invitation is withheld and the ' +
      'send route answers it exactly as it answers a send. While this is false, `withheld.noInvitation` can ' +
      'only stay at zero.',
  })
  inviteOnly!: boolean;
}
