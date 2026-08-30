import { ActivityRollup } from './activity-rollup.entity.js';
import { ApiKey } from './api-key.entity.js';
import { CreditTransaction } from './credit-transaction.entity.js';
import { Endpoint } from './endpoint.entity.js';
import { EvidenceSnapshot } from './evidence-snapshot.entity.js';
import { Generation } from './generation.entity.js';
import { Model } from './model.entity.js';
import { User } from './user.entity.js';
import { UserPreferences } from './user-preferences.entity.js';
import { Workspace } from './workspace.entity.js';
import { WorkspaceMember } from './workspace-member.entity.js';

export * from './activity-rollup.entity.js';
export * from './api-key.entity.js';
export * from './credit-transaction.entity.js';
export * from './endpoint.entity.js';
export * from './evidence-snapshot.entity.js';
export * from './generation.entity.js';
export * from './model.entity.js';
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
  CreditTransaction,
  Endpoint,
  EvidenceSnapshot,
  Generation,
  Model,
  User,
  UserPreferences,
  Workspace,
  WorkspaceMember,
];
