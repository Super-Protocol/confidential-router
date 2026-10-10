import { ActivityRollup } from './activity-rollup.entity.js';
import { ApiKey } from './api-key.entity.js';
import { ChatMessage } from './chat-message.entity.js';
import { ChatThread } from './chat-thread.entity.js';
import { CreditTransaction } from './credit-transaction.entity.js';
import { Endpoint } from './endpoint.entity.js';
import { EvidenceSnapshot } from './evidence-snapshot.entity.js';
import { ExternalEndpoint } from './external-endpoint.entity.js';
import { ExternalEndpointEvent } from './external-endpoint-event.entity.js';
import { FeedbackSubmission } from './feedback-submission.entity.js';
import { Generation } from './generation.entity.js';
import { InviteCarriedRedemption } from './invite-carried-redemption.entity.js';
import { InviteCode } from './invite-code.entity.js';
import { InviteRedemption } from './invite-redemption.entity.js';
import { Model } from './model.entity.js';
import { TrustedMeasurement } from './trusted-measurement.entity.js';
import { User } from './user.entity.js';
import { UserPreferences } from './user-preferences.entity.js';
import { Workspace } from './workspace.entity.js';
import { WorkspaceMember } from './workspace-member.entity.js';

export * from './activity-rollup.entity.js';
export * from './api-key.entity.js';
export * from './chat-message.entity.js';
export * from './chat-thread.entity.js';
export * from './credit-transaction.entity.js';
export * from './endpoint.entity.js';
export * from './evidence-snapshot.entity.js';
export * from './external-endpoint.entity.js';
export * from './external-endpoint-event.entity.js';
export * from './feedback-submission.entity.js';
export * from './generation.entity.js';
export * from './invite-carried-redemption.entity.js';
export * from './invite-code.entity.js';
export * from './invite-redemption.entity.js';
export * from './model.entity.js';
export * from './trusted-measurement.entity.js';
export * from './user.entity.js';
export * from './user-preferences.entity.js';
export * from './workspace.entity.js';
export * from './workspace-member.entity.js';

/**
 * Single registry of every entity, used by the Nest TypeORM module, the standalone
 * migration DataSource and the tests. Keeping one list is what stops the three
 * from drifting.
 */
export const ENTITIES = [
  ActivityRollup,
  ApiKey,
  ChatMessage,
  ChatThread,
  CreditTransaction,
  Endpoint,
  EvidenceSnapshot,
  ExternalEndpoint,
  ExternalEndpointEvent,
  FeedbackSubmission,
  Generation,
  InviteCarriedRedemption,
  InviteCode,
  InviteRedemption,
  Model,
  TrustedMeasurement,
  User,
  UserPreferences,
  Workspace,
  WorkspaceMember,
];
