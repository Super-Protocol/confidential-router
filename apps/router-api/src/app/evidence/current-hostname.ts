import type { DataSource, SelectQueryBuilder } from 'typeorm';
import { Endpoint } from '../db/entities/endpoint.entity.js';
import { EvidenceSnapshot } from '../db/entities/evidence-snapshot.entity.js';

/**
 * Snapshots of the named endpoints, restricted to the hostname each endpoint
 * answers on *now*.
 *
 * An endpoint row is keyed by its config `name` and keeps its identity across a
 * reconfigure that renames it, so the snapshots filed under it can span two
 * hostnames. The most recently issued of all of them is then not necessarily
 * this endpoint's current publication: it may be what the name it has stopped
 * answering on published, or — on a hostname taken over from another deployment
 * — what that deployment published while it still held the name (SUP-437).
 *
 * Shared rather than written twice because every surface that answers "what is
 * this endpoint publishing now" has to answer it the same way: the console's
 * Overview, `/v1/evidence`, and the coverage each generation is stamped with.
 *
 * A null `hostname` passes. It means the row predates the column rather than
 * that it belongs to another name, and reading the silence as a mismatch would
 * take every endpoint's evidence off the console until the next poll.
 */
export function snapshotsOnCurrentHostname(
  dataSource: DataSource,
  endpointIds: string[],
): SelectQueryBuilder<EvidenceSnapshot> {
  return dataSource
    .getRepository(EvidenceSnapshot)
    .createQueryBuilder('snapshot')
    .innerJoin(Endpoint, 'endpoint', 'endpoint.id = snapshot.endpointId')
    .where('snapshot.endpointId IN (:...endpointIds)', { endpointIds })
    .andWhere('(snapshot.hostname IS NULL OR snapshot.hostname = endpoint.hostname)');
}
