import { ENTITIES } from '../db/entities/index.js';
import { BUNDLE_SECTIONS } from './export-bundle.js';

/**
 * One decision per table: does it travel in the deployment export, or not —
 * and if not, why (SUP-445).
 *
 * This file exists because of how the API keys went missing. Nobody chose to
 * leave them behind; the section list simply never grew an `apiKeys` entry, and
 * a table that is in no list is dropped by every rebuild without a word. The
 * export cannot discover its own sections — it names columns one by one on
 * purpose, so that a new column is never exported by accident — which leaves the
 * opposite hole, and this registry is what fills it: `bundle-coverage.spec.ts`
 * fails the build when an entity appears in {@link ENTITIES} and not here.
 *
 * It covers the TypeORM schema — {@link ENTITIES} — and not the whole database.
 * Better Auth owns `account`, `session` and `verification` and this codebase has
 * no entity for them; they are credentials by definition, never read by the
 * export, and therefore out of scope here rather than silently uncovered.
 *
 * So the answer to "a new table showed up, what now?" is: add it below. Either
 * name the bundle section it travels in — and make the export, the plan and the
 * import carry it — or write down why it stays behind, in a sentence the next
 * person can disagree with. A reason beats silence even when the reason is
 * "nobody has needed it yet": that sentence is the thing an operator can find.
 */
export type BundleCoverage =
  /** Carried: `section` is the `data` section of the bundle it travels in. */
  | { readonly section: BundleSection; readonly note?: string }
  /** Left behind, with the reason. Anything a rebuild therefore loses belongs in it. */
  | { readonly notCarried: string };

export type BundleSection = (typeof BUNDLE_SECTIONS)[number];

/** Keyed by entity class name, which is what the spec reads off {@link ENTITIES}. */
export const BUNDLE_COVERAGE: Record<string, BundleCoverage> = {
  // ── carried ─────────────────────────────────────────────────────────────
  User: { section: 'users', note: 'Read through Better Auth, which owns the table; the entity is a projection.' },
  Workspace: { section: 'workspaces' },
  WorkspaceMember: { section: 'workspaceMembers' },
  CreditTransaction: { section: 'creditLedger' },
  InviteCode: { section: 'inviteCodes' },
  InviteRedemption: { section: 'inviteRedemptions', note: 'The salted IP and user-agent digests stay behind.' },
  ApiKey: {
    section: 'apiKeys',
    note: 'Hash included — the key keeps working after the redeploy. See the paragraph in export-bundle.ts.',
  },
  ExternalEndpoint: {
    section: 'externalEndpoints',
    note: 'Registration and pinned digest only: the verdict is re-derived live and the upstream key is sealed.',
  },
  Model: {
    section: 'externalEndpoints',
    note: 'Nested under each endpoint, and only `origin: external`: the config-born rows are reconciled from router.yaml at boot.',
  },
  TrustedMeasurement: { section: 'trustedMeasurements' },

  // ── left behind ─────────────────────────────────────────────────────────
  Endpoint: {
    notCarried:
      'This deployment’s own endpoints are a projection of `router.yaml`, reconciled by CatalogService at every boot. ' +
      'The new deployment has its own config and its own hostnames, so a carried row would be stale on arrival.',
  },
  EvidenceSnapshot: {
    notCarried:
      'What an endpoint published, and when. The new deployment publishes its own evidence about its own workloads; ' +
      'a snapshot from the old one describes containers that no longer run. Re-fetched within one poll of boot.',
  },
  ExternalEndpointEvent: {
    notCarried:
      'The verdict timeline of an upstream. Verdicts are never carried anywhere (data-model invariant 2) and the ' +
      'endpoint arrives switched off, so its history here would be another deployment’s checks. The timeline restarts.',
  },
  Generation: {
    notCarried:
      'Metering rows, the one table that grows without bound. Every debit they caused is a `usage` entry in the ' +
      'credit ledger, which does travel, so balances survive — per-request history does not, and Activity starts empty.',
  },
  ActivityRollup: {
    notCarried:
      'Hourly aggregate of `generations`. Derived data with nothing left to derive from once they stay behind.',
  },
  ChatThread: {
    notCarried:
      'Console-chat conversations: the one place in this schema that holds what a user typed (ADR-007 §4). ' +
      'Personal content rather than deployment state, and the bundle is a file an operator carries — so it stays out.',
  },
  ChatMessage: { notCarried: 'The turns of those conversations, for the same reason.' },
  FeedbackSubmission: {
    notCarried:
      'Survey answers held for the credit they earned. The credit itself travels in the ledger, and its ' +
      '`feedback:<userId>` idempotency key travels with it — so the grant cannot be made twice on the new deployment ' +
      'even though the answers are gone.',
  },
  UserPreferences: {
    notCarried:
      'Per-user console settings, written lazily on first change. Everyone starts on the defaults again on the new ' +
      'deployment: the loss is one click each, and the row holds nothing that cannot be re-chosen.',
  },
  MailAddressState: {
    notCarried:
      'What the mail provider has said about an address (SUP-551). The suppression list it mirrors lives at the ' +
      'provider and survives any rebuild of ours, so the new deployment is wrong about an address only until the ' +
      'next send to it — which produces the same bounced or suppressed webhook again, and the row with it. ' +
      'Self-healing state, in other words, and carrying it would carry one deployment’s `failures` counts into ' +
      'another deployment’s timeline. What is lost is the operator’s record of who was unreachable before the ' +
      'cutover; the process log of the old deployment still has it.',
  },
  InviteCarriedRedemption: {
    notCarried:
      'A redemption that happened on another deployment, recorded here by a codes CSV import (SUP-272). Not carried ' +
      'yet, and this one is a known gap rather than a decision: SUP-403 adds the section. Until it lands, a rebuild ' +
      'forgets that a carried code was already spent, and the same code can be redeemed here again.',
  },
};

/** The entity names {@link BUNDLE_COVERAGE} has to account for, read off the one registry. */
export function entityNames(): string[] {
  return ENTITIES.map((entity) => entity.name).sort();
}
