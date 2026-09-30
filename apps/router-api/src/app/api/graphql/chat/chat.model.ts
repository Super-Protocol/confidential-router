import { Field, GraphQLISODateTime, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsString } from 'class-validator';

/**
 * Where a console chat's conversation history is kept.
 *
 * The console reads this rather than assuming, because the answer decides what
 * the screen may *say*. `BROWSER_LOCAL` is today's answer: the thread never
 * leaves the visitor's own browser, so the screen must not claim server-side
 * storage, an encrypted-at-rest boundary, or a retention period it does not
 * have.
 *
 * `ATTESTED_SERVER` is reserved for when the platform can answer SUP-179 —
 * whether a tenant PVC on the in-TEE LUKS state disk survives a node reboot.
 * Until it can, a stored history would be a durability promise nobody has made,
 * so the value is not yet emitted by any deployment.
 */
export const ChatHistoryStorageEnum = {
  BROWSER_LOCAL: 'browser_local',
  ATTESTED_SERVER: 'attested_server',
} as const;

registerEnumType(ChatHistoryStorageEnum, {
  name: 'ChatHistoryStorage',
  description: 'Where a console chat keeps its history. The console derives its own disclosure copy from this.',
});

export type ChatHistoryStorage = (typeof ChatHistoryStorageEnum)[keyof typeof ChatHistoryStorageEnum];

@ObjectType('ChatSettings', {
  description:
    'What the console Chat screen is allowed to do, and where its history lives. Public: the limits are ' +
    'the same for everyone and the screen has to know them before a session exists.',
})
export class ChatSettingsModel {
  @Field(() => Boolean, { description: 'False removes the screen; `chatCredential` is refused too.' })
  enabled!: boolean;

  @Field(() => Int, { description: 'Longest single message the composer accepts.' })
  maxMessageChars!: number;

  @Field(() => Int, { description: 'How many threads one workspace may keep before the oldest is pruned.' })
  maxThreads!: number;

  @Field(() => Int, { description: 'How many messages one thread may hold.' })
  maxMessagesPerThread!: number;

  @Field(() => ChatHistoryStorageEnum, { description: 'See `ChatHistoryStorage`.' })
  historyStorage!: ChatHistoryStorage;

  @Field(() => [String], {
    description:
      'Model ids the chat may use — every enabled model that declares the `chat` capability, in config order.',
  })
  chatModelIds!: string[];
}

@ObjectType('ChatCredential', {
  description:
    'A short-lived workspace API key the Chat screen uses to call /v1/chat/completions. It is an ordinary ' +
    'key: the same guard authenticates it and the same meter bills it.',
})
export class ChatCredentialModel {
  @Field(() => ID, { description: 'The key row, so the console can name it in the Keys table.' })
  apiKeyId!: string;

  @Field(() => String, { description: 'The plaintext key. Returned once, held in memory by the tab, never stored.' })
  secret!: string;

  @Field(() => GraphQLISODateTime, { description: 'When it stops authenticating. Hours, not days.' })
  expiresAt!: Date;

  @Field(() => String, {
    description: 'The OpenAI-compatible base URL to send it to, e.g. https://api.example/v1.',
  })
  baseUrl!: string;

  @Field(() => [String], { description: 'Model ids this key may call — exactly the chat-capable catalogue.' })
  modelScope!: string[];
}

@InputType('ChatCredentialInput')
export class ChatCredentialInputModel {
  @Field(() => ID)
  @IsString()
  workspaceId!: string;
}
