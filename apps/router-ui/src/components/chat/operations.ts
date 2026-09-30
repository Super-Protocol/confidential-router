import { graphql } from '../../generated';

/**
 * Everything the Chat screen renders, and the one mutation it needs.
 *
 * The catalogue is the same fragment the Models screen uses, so the evidence the
 * chat verifies in the page is the evidence the rest of the console shows.
 * `capabilities` is asked for here and nowhere else: the picker offers chat-capable
 * models only, and a model that cannot chat would fail at LiteLLM.
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
    models {
      id
      name
      contextLength
      capabilities
      tee
      pricing {
        promptPer1m
        completionPer1m
      }
      endpoint {
        ...EndpointEvidenceFields
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
