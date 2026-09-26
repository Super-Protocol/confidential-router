import { InitialSchema1756600000000 } from './1756600000000-InitialSchema.js';
import { InviteCodes1758800000000 } from './1758800000000-InviteCodes.js';
import { FeedbackGrants1758900000000 } from './1758900000000-FeedbackGrants.js';
import { WorkspaceFirstRequest1759000000000 } from './1759000000000-WorkspaceFirstRequest.js';
import { ModelRequests1759100000000 } from './1759100000000-ModelRequests.js';

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
  ModelRequests1759100000000,
];
