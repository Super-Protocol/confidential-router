import { graphql } from '../../generated';

/**
 * Everything the Chat screen renders, and the one mutation it needs.
 *
 * The catalogue is the same fragment the Models screen uses, so the evidence the
 * chat verifies in the page is the evidence the rest of the console shows.
 * `capabilities` is asked for here and nowhere else: the picker offers chat-capable
 * models only, and a model that cannot chat would fail at LiteLLM.
 *
 * `routerEndpoint` is asked for separately from `models[].endpoint`, and the
 * distinction is the whole of the chat's attestation story since ADR-008. The
 * endpoint tier 1 must check is the one the **browser** is connected to — always
 * this router. For a built-in model that is also the endpoint serving it, and the
 * two were the same field; for an external model they come apart, `endpoint` is
 * null, and `routerEndpoint` is what the gate runs on. The upstream's own
 * evidence is a second, separate check, offered beside it rather than folded in.
 */
export const CHAT_SCREEN_QUERY = graphql(`
  query ChatScreen {
    chatSettings {
      enabled
      maxMessageChars
      maxThreads
      maxMessagesPerThread
      historyStorage
      chatModelIds
    }
    routerEndpoint {
      ...EndpointEvidenceFields
    }
    models {
      id
      name
      contextLength
      capabilities
      tee
      origin
      pricing {
        promptPer1m
        completionPer1m
      }
      endpoint {
        ...EndpointEvidenceFields
      }
      externalUpstream {
        ...ExternalUpstreamFields
      }
    }
  }
`);

/**
 * The key the tab talks to `/v1` with.
 *
 * Requested once per sitting and held in React state only — never in
 * localStorage, never in a cookie. It is a real workspace credential, and a
 * credential that outlives the tab that needed it is a credential somebody else
 * can find.
 */
export const CHAT_CREDENTIAL = graphql(`
  mutation ChatCredential($input: ChatCredentialInput!) {
    chatCredential(input: $input) {
      apiKeyId
      secret
      expiresAt
      baseUrl
      modelScope
    }
  }
`);

/**
 * The thread list. Titles only — a sidebar does not need transcripts, and asking
 * for them would put every conversation in the workspace on the wire to render
 * one of them.
 */
export const CHAT_THREADS = graphql(`
  query ChatThreads($workspaceId: ID!) {
    chatThreads(workspaceId: $workspaceId) {
      id
      title
      modelId
      updatedAt
    }
  }
`);

/** The open conversation, oldest turn first. */
export const CHAT_THREAD = graphql(`
  query ChatThread($workspaceId: ID!, $threadId: ID!) {
    chatThread(workspaceId: $workspaceId, threadId: $threadId) {
      id
      title
      modelId
      updatedAt
      messages {
        id
        role
        content
        error
        createdAt
      }
    }
  }
`);

export const CREATE_CHAT_THREAD = graphql(`
  mutation CreateChatThread($input: CreateChatThreadInput!) {
    createChatThread(input: $input) {
      id
      title
      modelId
      updatedAt
    }
  }
`);

export const SET_CHAT_THREAD_MODEL = graphql(`
  mutation SetChatThreadModel($input: CreateChatThreadInput!, $threadId: ID!) {
    setChatThreadModel(input: $input, threadId: $threadId) {
      id
      modelId
    }
  }
`);

/**
 * Records a turn that has already happened. Called twice per exchange — once
 * when the question is sent, once when the answer settles — so a tab that dies
 * mid-stream leaves the question in the transcript rather than losing the turn.
 */
export const APPEND_CHAT_MESSAGE = graphql(`
  mutation AppendChatMessage($input: AppendChatMessageInput!) {
    appendChatMessage(input: $input) {
      id
      role
      content
      error
      createdAt
    }
  }
`);

export const DELETE_CHAT_THREAD = graphql(`
  mutation DeleteChatThread($workspaceId: ID!, $threadId: ID!) {
    deleteChatThread(workspaceId: $workspaceId, threadId: $threadId)
  }
`);
