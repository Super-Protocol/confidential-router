import { Injectable } from '@nestjs/common';
import { type EndpointLiveness, type ExternalEndpointsStatus, summarise } from './external-endpoint-liveness.js';

/**
 * What `GET /health` says about registered external upstreams — the process
 * state behind it (SUP-517).
 *
 * A process-lifetime object rather than a query, for the reason `AnalyticsHealth`
 * is one (SUP-464) and one more that is specific to this: `/health` is public and
 * unauthenticated, and every status pass already has the rows in hand. Having the
 * public route issue its own `SELECT` per call would be paying for the same answer
 * twice and handing an anonymous caller a lever on the database.
 *
 * Fed by {@link ExternalEndpointStatusService}: once at boot from the reset, and
 * then after every pass — including a pass that could not read the sidecar, which
 * is the case the answer matters most in. `verdictsReadAt` moves only on a read
 * that worked, so a hung sidecar shows as counts that stopped moving next to a
 * timestamp that says when they stopped.
 */
@Injectable()
export class ExternalEndpointHealth {
  private livenesses: readonly EndpointLiveness[] = [];
  private verdictsReadAt: Date | null = null;

  /**
   * Publishes the latest view of every *enabled* endpoint.
   *
   * @param verdictsReadAt when the sidecar's verdicts behind this view were read,
   *   or null when this view came from the rows alone — a boot reset, or a pass
   *   whose sidecar read failed. A null never clears an earlier timestamp: the
   *   question it answers is "when did this router last hear from the sidecar",
   *   and the answer to that does not become "never" because one poll failed.
   */
  report(livenesses: readonly EndpointLiveness[], verdictsReadAt: Date | null): void {
    this.livenesses = livenesses;
    if (verdictsReadAt) {
      this.verdictsReadAt = verdictsReadAt;
    }
  }

  status(): ExternalEndpointsStatus {
    return summarise(this.livenesses, this.verdictsReadAt);
  }
}
