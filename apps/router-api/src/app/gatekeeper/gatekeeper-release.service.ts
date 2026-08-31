import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../config.js';
import { fetchLatestRelease, type PublishedRelease } from './release-fetcher.js';

export interface CachedRelease extends PublishedRelease {
  /** When this router last retrieved the release from GitHub. */
  fetchedAt: Date;
  /**
   * True when this is an aged copy served because the last refresh failed. The
   * screen still has its links; it just has to say how old they are.
   */
  stale: boolean;
}

/**
 * The Gatekeeper screen's download list, read from GitHub Releases and cached.
 *
 * Refreshed lazily, when the console asks and the cached copy has aged past
 * `gatekeeper.cacheTtl` — never on a timer, so an idle deployment makes no
 * outbound calls at all. Concurrent asks share one in-flight request, because a
 * console that N users open at once must not become N calls against an API that
 * rate-limits per source IP.
 *
 * A refresh that fails keeps the last good answer and marks it stale rather
 * than emptying the screen: GitHub being unreachable is not a reason to stop
 * telling a user which version they should be running.
 *
 * Nothing here is per-user or per-workspace, and nothing here learns anything
 * about attestation — the gatekeeper verifies endpoints on the user's own
 * machine and this router never hears about it (ADR-002).
 */
@Injectable()
export class GatekeeperReleaseService {
  private readonly logger = new Logger(GatekeeperReleaseService.name);
  private cached: CachedRelease | null = null;
  private inFlight: Promise<CachedRelease | null> | null = null;

  constructor(@Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>) {}

  /**
   * The latest published release, or null when none has ever been retrieved —
   * a repository with no release yet, or a first call that failed.
   */
  async latest(now: Date = new Date()): Promise<CachedRelease | null> {
    const cached = this.cached;
    if (cached && now.getTime() - cached.fetchedAt.getTime() < this.config.gatekeeper.cacheTtl) {
      return cached;
    }

    // Assigned before it is awaited, so a second caller arriving in the same
    // tick joins this request instead of starting another.
    this.inFlight ??= this.refresh(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async refresh(now: Date): Promise<CachedRelease | null> {
    const { repo, apiBaseUrl, token, requestTimeout } = this.config.gatekeeper;
    try {
      const release = await fetchLatestRelease({ repo, apiBaseUrl, token }, { timeoutMs: requestTimeout });
      this.cached = { ...release, fetchedAt: now, stale: false };
      return this.cached;
    } catch (error) {
      this.logger.warn(
        `Could not read the gatekeeper release of ${repo}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.cached ? { ...this.cached, stale: true } : null;
    }
  }
}
