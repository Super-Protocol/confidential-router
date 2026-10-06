import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvidenceSnapshot, evidenceSnapshotEndpointIsExclusive } from './evidence-snapshot.entity.js';
import { Generation, generationEndpointIsExclusive } from './generation.entity.js';
import { ENTITIES } from './index.js';
import { Model, modelOriginIsExclusive } from './model.entity.js';

/**
 * Executable versions of the invariants in `docs/contracts/data-model.md`.
 *
 * They walk TypeORM's entity metadata rather than reading the source, so adding
 * the offending column anywhere — including through a base class or a future
 * refactor — fails the build.
 */

let dataSource: DataSource;

beforeAll(async () => {
  dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: ENTITIES });
  await dataSource.initialize();
});

afterAll(async () => {
  await dataSource.destroy();
});

/** Types that can hold an arbitrary-length payload. */
const UNBOUNDED_TYPES = ['text', 'simple-json', 'json', 'jsonb', 'blob', 'bytea', 'simple-array'];

/** Names a content column would plausibly be given. */
const CONTENT_NAMES = [
  'prompt',
  'completion',
  'messages',
  'message',
  'content',
  'text',
  'input',
  'output',
  'response',
  'body',
];

/** Longest string a metering row legitimately needs (a model id). */
const MAX_STRING_LENGTH = 255;

describe('Generation', () => {
  it('has no column of a type that could hold prompt or completion text', () => {
    const offenders = dataSource
      .getMetadata(Generation)
      .columns.filter((column) => UNBOUNDED_TYPES.includes(String(column.type)))
      .map((column) => `${column.propertyName}: ${String(column.type)}`);

    expect(offenders).toEqual([]);
  });

  it('bounds every string column to an identifier-sized length', () => {
    const offenders = dataSource
      .getMetadata(Generation)
      .columns.filter((column) => String(column.type) === 'varchar')
      .filter((column) => !column.length || Number(column.length) > MAX_STRING_LENGTH)
      .map((column) => `${column.propertyName}: varchar(${column.length || 'unbounded'})`);

    expect(offenders).toEqual([]);
  });

  it('has no column named after request or response content', () => {
    const offenders = dataSource
      .getMetadata(Generation)
      .columns.map((column) => column.propertyName)
      .filter((name) => CONTENT_NAMES.includes(name.toLowerCase()));

    expect(offenders).toEqual([]);
  });
});

describe('EvidenceSnapshot', () => {
  it('records no verdict about the evidence it stores', () => {
    // The router publishes evidence and never judges it; verification happens in
    // the user's gatekeeper (ADR-002). A boolean here would be that judgement.
    //
    // ADR-008 narrows invariant 2 but not this clause: toward an external upstream
    // the router *does* hold a verdict, and it lives on `external_endpoints`,
    // re-derived live. What this table stores is still only what was published —
    // for the router's own endpoints and for an external upstream alike.
    const metadata = dataSource.getMetadata(EvidenceSnapshot);
    const verdictish = metadata.columns
      .map((column) => column.propertyName)
      .filter((name) => /valid|verified|trusted|verdict|allowed|attested/i.test(name));

    expect(verdictish).toEqual([]);
  });

  it('is unique per (publisher, digest, certificate, issuedAt) so polling is idempotent', () => {
    const metadata = dataSource.getMetadata(EvidenceSnapshot);
    const unique = metadata.indices
      .filter((index) => index.isUnique)
      .map((index) => index.columns.map((column) => column.propertyName).join(','))
      .sort();

    // One identity key per publisher kind, and both are needed: a unique index
    // treats NULLs as distinct on either driver, so the own-endpoint key would
    // never collide for an upstream's rows and every poll would append a
    // duplicate (ADR-008 §6).
    expect(unique).toEqual([
      'endpointId,evidenceDigest,certFingerprint,issuedAt',
      'externalEndpointId,evidenceDigest,certFingerprint,issuedAt',
    ]);
  });

  it('is published by an external upstream or by one of ours, never both and never neither', () => {
    const columns = dataSource.getMetadata(EvidenceSnapshot).columns;

    expect(columns.find((column) => column.propertyName === 'endpointId')?.isNullable).toBe(true);
    expect(columns.find((column) => column.propertyName === 'externalEndpointId')?.isNullable).toBe(true);

    expect(evidenceSnapshotEndpointIsExclusive({ endpointId: 'e1', externalEndpointId: null })).toBe(true);
    expect(evidenceSnapshotEndpointIsExclusive({ endpointId: null, externalEndpointId: 'x1' })).toBe(true);
    // Both: an upstream's publications would show up in our own endpoint's digest
    // history. Neither: the row belongs to nobody and no screen can reach it.
    expect(evidenceSnapshotEndpointIsExclusive({ endpointId: 'e1', externalEndpointId: 'x1' })).toBe(false);
    expect(evidenceSnapshotEndpointIsExclusive({ endpointId: null, externalEndpointId: null })).toBe(false);
  });
});

/**
 * Invariant 2, as ADR-008 §1 narrows it.
 *
 * "No table stores a verification verdict" becomes "no table stores a
 * verification verdict **about this deployment's own endpoints**". The narrowing
 * is one sentence and it buys a whole feature, so the checks that keep it from
 * becoming a general licence are worth more than the ones it replaced:
 *
 *  - the exception is named, and only these two tables are in it;
 *  - the verdict columns describe *someone else* — there is no column here about
 *    this router's own attestation state, which is the half ADR-002 still owns;
 *  - the timeline is append-only, because a verdict history that could be edited
 *    is not a history;
 *  - the status column is re-derivable: nothing in the schema marks a verdict as
 *    durable, cached-until, or otherwise still good after a restart.
 */
describe('the external-endpoint verdict exception', () => {
  /** Tables allowed to hold verdict state, and about whom. */
  const VERDICT_EXCEPTIONS = ['external_endpoints', 'external_endpoint_events'];

  it('is the only part of the schema holding verdict state', () => {
    const offenders = dataSource.entityMetadatas
      .filter((metadata) => !VERDICT_EXCEPTIONS.includes(metadata.tableName))
      .flatMap((metadata) =>
        metadata.columns
          .map((column) => column.propertyName)
          // `verified`/`denied` as a *value* of `status` is fine; a column named
          // after a verdict is what invariant 2 is about.
          .filter((name) => /^(isValid|valid|verified|trusted|verdict|allowed|attested)/i.test(name))
          .map((name) => `${metadata.tableName}.${name}`),
      );

    expect(offenders).toEqual([]);
  });

  it('holds a verdict about an upstream and none about this deployment', () => {
    // The columns below are all "what we observed about them". The absence of an
    // `ownStatus`, `selfVerified` or `attestedAt` beside them is ADR-002's rule
    // still standing: the router does not learn a verdict about itself.
    const columns = dataSource.getMetadata('external_endpoints').columns.map((column) => column.propertyName);

    expect(columns).toContain('status');
    expect(columns).toContain('measurementSeen');
    expect(columns).toContain('evidenceDigestSeen');
    expect(columns).toContain('pinnedCertFingerprint');
    expect(columns.filter((name) => /^(self|own)/i.test(name))).toEqual([]);
  });

  it('keeps the timeline append-only', () => {
    const columns = dataSource.getMetadata('external_endpoint_events').columns.map((column) => column.propertyName);

    expect(columns).not.toContain('updatedAt');
  });

  it('claims no durability for a verdict, so a restart can only re-derive it', () => {
    // On boot every endpoint is forced back to `pending` and the sidecar attests
    // from nothing (ADR-008 §8). A column promising otherwise — `verifiedUntil`,
    // `trustExpiresAt`, `cachedVerdict` — would be the persisted trust the design
    // refuses, and it would be refused here before it ever had a reader.
    const columns = dataSource
      .getMetadata('external_endpoints')
      .columns.map((column) => column.propertyName)
      .filter((name) => /until|expires|cached|persist|durable/i.test(name));

    expect(columns).toEqual([]);
  });
});

/**
 * The upstream API key is reversible, and that is the point — the router has to
 * send it. So the structure has to carry the promise the design makes about it
 * (ADR-008 §6, threat T15): the ciphertext and a display prefix, and nothing that
 * could hold or hash the plaintext.
 */
describe('the stored upstream API key', () => {
  it('is stored as a ciphertext and a prefix, and nothing else', () => {
    const keyish = dataSource
      .getMetadata('external_endpoints')
      .columns.map((column) => column.propertyName)
      .filter((name) => /key|secret|token|credential/i.test(name))
      .sort();

    expect(keyish).toEqual(['apiKeyCiphertext', 'apiKeyPrefix']);
  });

  it('bounds the ciphertext, so the column cannot become somewhere to put a blob', () => {
    const ciphertext = dataSource
      .getMetadata('external_endpoints')
      .columns.find((column) => column.propertyName === 'apiKeyCiphertext');

    expect(String(ciphertext?.type)).toBe('varchar');
    expect(Number(ciphertext?.length)).toBeLessThanOrEqual(1024);
  });
});

/**
 * Invariant 4, as ADR-008 §6 narrows it: one catalogue table, two origins, and a
 * row belongs to exactly one of them.
 *
 * The XOR is a database shape rather than a convention because every downstream
 * query — `/v1/models`, key scopes, metering, Activity, Logs — reads this table
 * without knowing which kind of row it has. A row with both set would resolve to
 * two endpoints; a row with neither would resolve to none and still be listed.
 */
describe('the models catalogue', () => {
  it('can point at an external endpoint instead of one of ours', () => {
    const columns = dataSource.getMetadata(Model).columns;
    const endpointId = columns.find((column) => column.propertyName === 'endpointId');
    const externalEndpointId = columns.find((column) => column.propertyName === 'externalEndpointId');

    expect(columns.map((column) => column.propertyName)).toContain('origin');
    expect(endpointId?.isNullable).toBe(true);
    expect(externalEndpointId?.isNullable).toBe(true);
  });

  it('calls a row exclusive only when exactly one kind of endpoint is named', () => {
    // The exclusivity is applied by the writer rather than by a CHECK constraint
    // (see the migration on why), so the rule itself has to be one testable
    // function instead of a condition each writer remembers.
    expect(modelOriginIsExclusive({ origin: 'config', endpointId: 'e1', externalEndpointId: null })).toBe(true);
    expect(modelOriginIsExclusive({ origin: 'external', endpointId: null, externalEndpointId: 'x1' })).toBe(true);

    expect(modelOriginIsExclusive({ origin: 'config', endpointId: 'e1', externalEndpointId: 'x1' })).toBe(false);
    expect(modelOriginIsExclusive({ origin: 'external', endpointId: null, externalEndpointId: null })).toBe(false);
    // The origin has to agree with the column that is set: a config row pointing
    // at an external endpoint would be listed by one query and metered by another
    // as if it were two different models.
    expect(modelOriginIsExclusive({ origin: 'config', endpointId: null, externalEndpointId: 'x1' })).toBe(false);
    expect(modelOriginIsExclusive({ origin: 'external', endpointId: 'e1', externalEndpointId: null })).toBe(false);
  });
});

/**
 * The same XOR on `generations`, which ADR-008's egress leg made necessary: a
 * metered request went either to one of this deployment's endpoints or out
 * through an external one, never to both and never to neither.
 */
describe('a metered request’s endpoint', () => {
  it('may be an external one instead of ours', () => {
    const columns = dataSource.getMetadata(Generation).columns;

    expect(columns.find((column) => column.propertyName === 'endpointId')?.isNullable).toBe(true);
    expect(columns.find((column) => column.propertyName === 'externalEndpointId')?.isNullable).toBe(true);
  });

  it('is exactly one of the two, and the rule is one testable function', () => {
    expect(generationEndpointIsExclusive({ endpointId: 'e1', externalEndpointId: null })).toBe(true);
    expect(generationEndpointIsExclusive({ endpointId: null, externalEndpointId: 'x1' })).toBe(true);

    // Both: counted once in the per-endpoint token totals and once as external
    // traffic. Neither: counted in no screen at all, which is how a billing row
    // becomes impossible to find.
    expect(generationEndpointIsExclusive({ endpointId: 'e1', externalEndpointId: 'x1' })).toBe(false);
    expect(generationEndpointIsExclusive({ endpointId: null, externalEndpointId: null })).toBe(false);
  });

  it('still stores no verdict of its own — the digest it keeps is a fact, not a decision', () => {
    // ADR-008 §1 narrows data-model invariant 2 to `external_endpoints` and its
    // event timeline. `generations` was not part of that narrowing and must not
    // drift into it: `evidenceDigest` names *which* bundle covered the request,
    // and nothing here says whether it verified.
    const columns = dataSource.getMetadata(Generation).columns.map((column) => column.propertyName.toLowerCase());

    for (const forbidden of ['verified', 'verdict', 'admitted', 'attested', 'trusted', 'measurement']) {
      expect(columns.filter((column) => column.includes(forbidden))).toEqual([]);
    }
  });
});

describe('CreditTransaction', () => {
  it('has no updatedAt, because the ledger is append-only', () => {
    const metadata = dataSource.getMetadata('credit_transactions');
    expect(metadata.columns.map((column) => column.propertyName)).not.toContain('updatedAt');
  });

  it('has a unique idempotency key so a redelivered webhook cannot double-charge', () => {
    const metadata = dataSource.getMetadata('credit_transactions');
    const unique = metadata.indices.filter((index) => index.isUnique);
    expect(unique.flatMap((index) => index.columns.map((column) => column.propertyName))).toContain('idempotencyKey');
  });
});

/**
 * The console chat's invariant (SUP-180).
 *
 * The chat is a demo surface for someone who will not install a gatekeeper, and
 * the promise it makes is that talking to a model through the console is no
 * worse for privacy than talking to it through the API. That promise is only
 * worth the structure behind it: the conversation lives in the visitor's own
 * browser, and the prompt itself travels the ordinary `/v1/chat/completions`
 * path, which stores no content at all.
 *
 * So the `Generation` rules above are widened to the whole schema. If
 * server-side history ever lands — it waits on SUP-179's verdict on tenant-PVC
 * durability — the chat tables are the one documented exception, and they have
 * to be *named* here rather than quietly slipping past a scan.
 */
describe('the schema as a whole', () => {
  /** Tables allowed to hold a column named after content, and why. */
  const CONTENT_EXCEPTIONS: Record<string, string> = {
    chat_messages:
      'The console chat transcript — the one documented exception (ADR-007 §4). The user asked us to keep ' +
      'this; `generations` still holds no content, and the message still reached the model over the ordinary ' +
      '/v1 path that records none.',
  };

  it('has no table outside the exceptions holding a column named after message content', () => {
    const offenders = dataSource.entityMetadatas.flatMap((metadata) =>
      metadata.columns
        .map((column) => column.propertyName)
        .filter((name) => CONTENT_NAMES.includes(name.toLowerCase()))
        .filter(() => CONTENT_EXCEPTIONS[metadata.tableName] === undefined)
        .map((name) => `${metadata.tableName}.${name}`),
    );

    expect(offenders).toEqual([]);
  });

  it('keeps the exception to exactly one column of exactly one table', () => {
    // The exception is a door, and this is the doorstop. `chat_messages.content`
    // is the only place in the schema where something a user typed or a model
    // answered is stored; anything else acquiring a content column is either a
    // mistake or needs its own line in CONTENT_EXCEPTIONS and its own argument.
    const contentColumns = dataSource.entityMetadatas.flatMap((metadata) =>
      metadata.columns
        .map((column) => column.propertyName)
        .filter((name) => CONTENT_NAMES.includes(name.toLowerCase()))
        .map((name) => `${metadata.tableName}.${name}`),
    );

    expect(contentColumns).toEqual(['chat_messages.content']);
  });
});

/**
 * The console chat's own invariant (SUP-180, ADR-007 §4).
 *
 * The tables exist now that Denis has unblocked server-side history, so the
 * question is no longer "are they absent" but "is the exception still bounded".
 * Two properties make it bounded, and both are structural rather than a
 * convention somebody has to remember:
 *
 *  - a transcript belongs to one member of one workspace, so it cannot be read
 *    by the tenant it sits in;
 *  - nothing else in the service reads the content — see
 *    `app/chat/chat-content-boundary.spec.ts` for the paths it must not reach.
 */
describe('the chat tables', () => {
  it('exist, so the documented exception describes something real', () => {
    const tables = dataSource.entityMetadatas.map((metadata) => metadata.tableName);

    expect(tables).toContain('chat_threads');
    expect(tables).toContain('chat_messages');
  });

  it('scopes a thread to one member of one workspace, not to the workspace', () => {
    // A workspace has members, and one member's demo transcript is not another's
    // to read. `userId` is what makes that true; without it the scoping would be
    // a convention in whichever query happened to remember it.
    const columns = dataSource.getMetadata('chat_threads').columns.map((column) => column.propertyName);

    expect(columns).toContain('workspaceId');
    expect(columns).toContain('userId');
  });

  it('indexes the lookup both the list and the pruning use', () => {
    const index = dataSource
      .getMetadata('chat_threads')
      .indices.find((candidate) => candidate.columns.some((column) => column.propertyName === 'userId'));

    expect(index?.columns.map((column) => column.propertyName)).toEqual(['workspaceId', 'userId', 'updatedAt']);
  });

  it('cascades messages from their thread, so a delete is one statement', () => {
    const relation = dataSource
      .getMetadata('chat_messages')
      .relations.find((candidate) => candidate.propertyName === 'thread');

    expect(relation?.onDelete).toBe('CASCADE');
  });

  it('records no verdict, retention or backup field that would imply durability', () => {
    // Denis deferred the durability work and accepted the risk: the state disk
    // is ephemeral by design. A column here promising otherwise — `expiresAt`,
    // `retainUntil`, `backedUpAt` — would be a promise the platform has not made.
    const columns = [
      ...dataSource.getMetadata('chat_threads').columns,
      ...dataSource.getMetadata('chat_messages').columns,
    ]
      .map((column) => column.propertyName)
      .filter((name) => /retain|expire|backup|archiv|durable/i.test(name));

    expect(columns).toEqual([]);
  });
});

describe('ApiKey', () => {
  it('bounds purpose to an identifier-sized length, so it cannot become a notes field', () => {
    const purpose = dataSource.getMetadata('api_keys').columns.find((column) => column.propertyName === 'purpose');

    expect(purpose).toBeDefined();
    expect(Number(purpose?.length)).toBeLessThanOrEqual(32);
  });
});

describe('User', () => {
  it('is mapped read-only: TypeORM never synchronises the Better Auth table', () => {
    const metadata = dataSource.getMetadata('user');
    expect(metadata.synchronize).toBe(false);
  });
});
