import { InitialSchema1756600000000 } from './1756600000000-InitialSchema.js';
import { InviteCodes1758800000000 } from './1758800000000-InviteCodes.js';
import { FeedbackGrants1758900000000 } from './1758900000000-FeedbackGrants.js';
import { WorkspaceFirstRequest1759000000000 } from './1759000000000-WorkspaceFirstRequest.js';
import { ConsoleChatKeys1759100000000 } from './1759100000000-ConsoleChatKeys.js';
import { ChatHistory1759200000000 } from './1759200000000-ChatHistory.js';
import { EndpointDeclaredImages1759300000000 } from './1759300000000-EndpointDeclaredImages.js';
import { ExternalEndpoints1759400000000 } from './1759400000000-ExternalEndpoints.js';
import { ExternalGenerationEndpoint1759500000000 } from './1759500000000-ExternalGenerationEndpoint.js';
import { ExternalEndpointEvidence1759600000000 } from './1759600000000-ExternalEndpointEvidence.js';
import { ExternalEndpointRegistrySignal1759700000000 } from './1759700000000-ExternalEndpointRegistrySignal.js';
import { ExternalEndpointPinnedDigest1759800000000 } from './1759800000000-ExternalEndpointPinnedDigest.js';
import { InviteCodeIssuer1759900000000 } from './1759900000000-InviteCodeIssuer.js';

/**
 * Migrations are imported rather than globbed: the production build is a single
 * webpack bundle, so a glob would find nothing at runtime.
 *
 * Order is the array order, so new migrations are appended, never inserted.
 */
export const MIGRATIONS = [
  InitialSchema1756600000000,
  InviteCodes1758800000000,
  FeedbackGrants1758900000000,
  WorkspaceFirstRequest1759000000000,
  ConsoleChatKeys1759100000000,
  ChatHistory1759200000000,
  EndpointDeclaredImages1759300000000,
  ExternalEndpoints1759400000000,
  ExternalGenerationEndpoint1759500000000,
  ExternalEndpointEvidence1759600000000,
  ExternalEndpointRegistrySignal1759700000000,
  ExternalEndpointPinnedDigest1759800000000,
  InviteCodeIssuer1759900000000,
];
