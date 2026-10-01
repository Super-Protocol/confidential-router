import { Field, GraphQLISODateTime, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import type { ChatMessage, ChatRole } from '../../../db/entities/chat-message.entity.js';
import type { ChatThread } from '../../../db/entities/chat-thread.entity.js';

/**
 * Where a console chat's conversation history is kept.
 *
 * The console reads this rather than assuming, because the answer decides what
 * the screen may *say*. `ATTESTED_SERVER` is today's answer: threads live in
 * `chat_threads` / `chat_messages` on the deployment's own state, which sits
 * inside the attested boundary and is encrypted at rest by the in-TEE LUKS disk
 * — the host sees ciphertext and the key never persists.
 *
 * What that value does **not** license is a durability promise. Denis deferred
 * the durability work and accepted the risk (2026-09-30, after SUP-179): the
 * state disk is ephemeral by design, so a transcript can be lost during
 * infrastructure maintenance. Every surface that mentions storage says that in
 * the same breath; `ATTESTED_SERVER` means "stored inside the boundary", not
 * "kept safe".
 *
 * `BROWSER_LOCAL` is kept in the enum because it is the honest answer for any
 * deployment that has no such storage, and because the console still derives its
 * copy from whichever value it is given rather than hard-coding one.
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

/** GraphQL spelling of `ChatRole`; the values are what the column holds. */
export const ChatRoleEnum = {
  USER: 'user',
  ASSISTANT: 'assistant',
} as const satisfies Record<string, ChatRole>;

registerEnumType(ChatRoleEnum, { name: 'ChatRole', description: 'Who said it. There is no system role.' });

@ObjectType('ChatMessage', {
  description:
    'One turn of a conversation, content and all — the one documented exception to the rule that no ' +
    'request content reaches this database (ADR-007 §4). `generations` still holds none.',
})
export class ChatMessageModel {
  @Field(() => ID)
  id!: string;

  @Field(() => ChatRoleEnum)
  role!: ChatRole;

  @Field(() => String)
  content!: string;

  @Field(() => String, {
    nullable: true,
    description: 'The gateway’s refusal for a turn that ended badly. A failed turn stays in the transcript.',
  })
  error!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  static from(message: ChatMessage): ChatMessageModel {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      error: message.error,
      createdAt: message.createdAt,
    };
  }
}

@ObjectType('ChatThread', { description: 'One conversation. Scoped to the member who started it, never shared.' })
export class ChatThreadModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { description: 'Derived from the first user message, never typed by the user.' })
  title!: string;

  @Field(() => String)
  modelId!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  @Field(() => [ChatMessageModel], {
    description: 'Oldest first. Empty on the thread list, which asks for titles only.',
  })
  messages!: ChatMessageModel[];

  static from(thread: ChatThread, messages: ChatMessage[] = []): ChatThreadModel {
    return {
      id: thread.id,
      title: thread.title,
      modelId: thread.modelId,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      messages: messages.map((message) => ChatMessageModel.from(message)),
    };
  }
}

@InputType('CreateChatThreadInput')
export class CreateChatThreadInputModel {
  @Field(() => ID)
  @IsString()
  workspaceId!: string;

  @Field(() => String)
  @IsString()
  @Length(1, 255)
  modelId!: string;
}

@InputType('AppendChatMessageInput')
export class AppendChatMessageInputModel {
  @Field(() => ID)
  @IsString()
  workspaceId!: string;

  @Field(() => ID)
  @IsString()
  threadId!: string;

  /**
   * Decorated, and it has to be: the global `ValidationPipe` runs with
   * `whitelist` + `forbidNonWhitelisted`, so an undecorated `@Field` is stripped
   * and then refused as a property that "should not exist". Without this line
   * every `appendChatMessage` was a Bad Request and the console stored nothing
   * at all (SUP-187).
   */
  @Field(() => ChatRoleEnum)
  @IsEnum(ChatRoleEnum)
  role!: ChatRole;

  /**
   * No `@Length` ceiling here on purpose: the real limit is
   * `chat.maxMessageChars`, which the service reads from config and refuses
   * against. A second number in a decorator would be the one that goes stale.
   */
  @Field(() => String)
  @IsString()
  content!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @Length(0, 512)
  error?: string;
}
