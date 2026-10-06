import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { routerConfig } from '../config.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { TrustedMeasurement } from '../db/entities/trusted-measurement.entity.js';
import { renderSidecarConfig } from './sidecar-config.js';

export interface RenderResult {
  /** Whether the bytes on disk changed — i.e. whether the sidecar will reload. */
  changed: boolean;
  endpoints: number;
  trustedMeasurements: number;
}

/**
 * Keeps the sidecar's config file equal to the database (ADR-008 §5 step 1).
 *
 * Called on boot and after every admin mutation, which is what makes a trust-list
 * edit live within one reload plus one re-attest rather than after the TTL: the
 * sidecar's reload rebuilds the verifier, discards every cached verdict and
 * force-re-attests the survivors (ADR-003 §7, `pkg/proxy/supervisor.go`).
 *
 * The write is atomic — a temporary file in the same directory, then a rename —
 * because the sidecar's entrypoint watches this path and a partial read is a
 * config that fails validation. A failed validation changes nothing on the
 * sidecar's side, so a torn write would not be unsafe, only a confusing reload
 * that the next render would have to undo.
 *
 * Unchanged bytes are not rewritten. `renderSidecarConfig` is deterministic, so
 * comparing is enough to tell "nothing an endpoint cares about moved" from "a
 * mutation happened", and re-attesting every upstream because a row's
 * `lastCheckedAt` ticked would be the opposite of what the poll is for.
 */
@Injectable()
export class SidecarConfigWriterService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SidecarConfigWriterService.name);

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const result = await this.render();
      this.logger.log(
        `Sidecar config: ${result.endpoints} external endpoint(s), ${result.trustedMeasurements} trusted ` +
          `measurement(s)${result.changed ? '' : ' (unchanged)'}.`,
      );
    } catch (error) {
      // A render failure must not stop the API from booting: with no file the
      // sidecar serves nothing, which is the fail-closed state anyway, and the
      // console is how an operator finds out why.
      this.logger.error(`Sidecar config could not be rendered: ${messageOf(error)}`);
    }
  }

  /**
   * Renders the current database state and writes it if it differs.
   *
   * Disabled endpoints are left out entirely rather than rendered and stopped:
   * an endpoint the sidecar has never heard of cannot be reached by a stale
   * verdict, and `status: 'disabled'` is the row's own record of why.
   */
  async render(): Promise<RenderResult> {
    const [endpoints, measurements] = await Promise.all([
      this.dataSource.getRepository(ExternalEndpoint).find({ where: { enabled: true }, order: { name: 'ASC' } }),
      this.dataSource.getRepository(TrustedMeasurement).find({ order: { measurement: 'ASC' } }),
    ]);

    const rendered = renderSidecarConfig({
      endpoints: endpoints.map((endpoint) => ({
        name: endpoint.name,
        baseUrl: endpoint.baseUrl,
        listenPort: endpoint.listenPort,
      })),
      trustedMeasurements: measurements.map((row) => row.measurement),
      adminListen: this.config.externalEndpoints.adminListen,
      reattestIntervalMs: this.config.externalEndpoints.reattestInterval,
    });

    const changed = await this.writeIfChanged(rendered);
    return { changed, endpoints: endpoints.length, trustedMeasurements: measurements.length };
  }

  private async writeIfChanged(rendered: string): Promise<boolean> {
    const path = this.config.externalEndpoints.configFile;
    if ((await readOrNull(path)) === rendered) {
      return false;
    }
    await mkdir(dirname(path), { recursive: true });
    // Same directory, so the rename is within one filesystem and therefore
    // atomic: a watcher sees the old file or the new one, never a half of either.
    const temporary = `${path}.tmp`;
    await writeFile(temporary, rendered, { encoding: 'utf8', mode: 0o640 });
    await rename(temporary, path);
    return true;
  }
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
