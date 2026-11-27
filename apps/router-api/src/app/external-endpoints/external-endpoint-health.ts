import { Injectable } from '@nestjs/common';
import {
  type CatalogueReach,
  type EndpointLiveness,
  type ExternalEndpointsStatus,
  summarise,
} from './external-endpoint-liveness.js';

/** The reach of a deployment that has published nothing yet: it knows of no model. */
const NOTHING_PUBLISHED: CatalogueReach = {
  routable: 0,
  models: 0,
  routableModels: 0,
  disabled: 0,
  awaitingKey: 0,
  darkness: { dark: false, since: null, outage: false },
};

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
  private verdictsReadAt: Date | null = null;
  /**
   * The answer, formed when it was published rather than when it is asked for.
   *
   * Eager because the summary is a statement about a pass — every number in it
   * was already fixed by `livenessOf` at that pass's clock — and because the
   * `outage` promotion keyed on {@link behind} has to be evaluated once per
   * pass. Computing it per reader would count one pass many times or none,
   * depending on who called `/health` and when.
   */
  private summary: ExternalEndpointsStatus = summarise([], null, { ...NOTHING_PUBLISHED, behindBefore: false });
  /**
   * Whether the last published pass had the catalogue short of the rows
   * (SUP-600).
   *
   * The one piece of state that spans passes, and the reason the promotion to
   * `outage` is trustworthy: a pass reads the rows at its start and rebuilds the
   * catalogue at its end, so a write landing between the two makes this true for
   * a single pass with nothing wrong. The pod booting beside this one does
   * exactly that on every rolling update. Requiring two in a row costs one poll
   * of delay on a fault that lasted the life of a pod.
   */
  private behind = false;

  /**
   * Publishes the latest view of every *enabled* endpoint, and the counts that
   * describe the ones that are not (SUP-879).
   *
   * @param verdictsReadAt when the sidecar's verdicts behind this view were read,
   *   or null when this view came from the rows alone — a boot reset, or a pass
   *   whose sidecar read failed. A null never clears an earlier timestamp: the
   *   question it answers is "when did this router last hear from the sidecar",
   *   and the answer to that does not become "never" because one poll failed.
   * @param reach what the catalogue the gateway resolves against will actually
   *   route to, as the same pass left it, plus the counts no `livenesses` entry
   *   can carry — the switched-off rows, the unkeyed ones, and the
   *   deployment-level darkness verdict. The second reader, so that the two
   *   cannot disagree in silence ({@link ExternalEndpointsStatus.routable},
   *   SUP-600; {@link CatalogueDarkness}, SUP-879).
   */
  report(livenesses: readonly EndpointLiveness[], verdictsReadAt: Date | null, reach: CatalogueReach): void {
    if (verdictsReadAt) {
      this.verdictsReadAt = verdictsReadAt;
    }
    this.summary = summarise(livenesses, this.verdictsReadAt, { ...reach, behindBefore: this.behind });
    this.behind = this.summary.routable < this.summary.serving;
  }

  status(): ExternalEndpointsStatus {
    return this.summary;
  }
}
