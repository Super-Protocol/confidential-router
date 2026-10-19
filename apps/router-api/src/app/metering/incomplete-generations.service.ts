import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { routerConfig } from '../config.js';
import { Generation } from '../db/entities/generation.entity.js';

/**
 * The `errorCode` a generation nobody ever closed ends up with.
 *
 * Metering-only: it is not in the `/v1` error table and never reaches an HTTP
 * body, because by definition no response was written — the router stopped
 * before it could say anything. It reads on the Logs screen exactly as
 * `backend_unavailable` does, which is the point: $0.00, 0/0 tokens, and a name
 * for what went wrong.
 */
export const NO_RESPONSE_CODE = 'no_response';

/** How often the sweep runs. Short enough that a restart is visible promptly. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Closes generations that were admitted and never finished.
 *
 * A row is written `pending` before anything is forwarded and replaced when the
 * gateway is done with it (`MeteringService.open` / `close`). Almost always the
 * second write happens milliseconds later. What this service is for is the case
 * where it never happens at all: the process was restarted mid-request, the pod
 * was evicted, the edge answered the client 502 and tore the connection down.
 * Those rows would otherwise sit `pending` forever, which is a different way of
 * being invisible than having no row — the account still could not tell what
 * became of the request it paid sixty seconds of its agent's time for (SUP-423).
 *
 * Replica-safe without a lock, like the evidence pollers: one conditional
 * `UPDATE` over `status = 'pending' AND createdAt < cutoff`. N replicas issuing
 * it concurrently converge on the same rows; whichever lands first does the work
 * and the rest match nothing.
 *
 * The cutoff is `metering.incompleteAfter` and must stay comfortably longer than
 * the longest generation a deployment serves — a sweep that fires under a
 * running stream would mark a live request failed and then be overwritten by the
 * truth, which is a worse lie than the delay it saves.
 */
@Injectable()
export class IncompleteGenerationSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(IncompleteGenerationSweeper.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.metering.incompleteAfter <= 0) {
      this.logger.log(
        'Incomplete generations will not be closed (metering.incompleteAfter is 0); a request the router does not ' +
          'live to finish will stay pending in Logs.',
      );
      return;
    }
    // The first pass is the one that matters most: if this process is replacing
    // one that died under a request, that request's row is already overdue.
    void this.sweepOnce();
    this.timer = setInterval(() => void this.sweepOnce(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pass, exposed so a test can await it rather than sleep for one. */
  async sweepOnce(now: Date = new Date()): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const cutoff = now.getTime() - this.config.metering.incompleteAfter;
      const closed = await this.dataSource
        .createQueryBuilder()
        .update(Generation)
        .set({ status: 'error', errorCode: NO_RESPONSE_CODE })
        .where('status = :pending', { pending: 'pending' })
        // `createdAt` is epoch milliseconds on both drivers (`timestampColumn`),
        // so the bound value is a number, exactly as the activity queries bind it.
        .andWhere('createdAt < :cutoff', { cutoff })
        .execute();

      const affected = closed.affected ?? 0;
      if (affected > 0) {
        this.logger.warn(
          `Closed ${affected} generation(s) that were admitted and never finished as ${NO_RESPONSE_CODE}; ` +
            'the router did not survive to meter them.',
        );
      }
      return affected;
    } catch (error) {
      // The next pass is a minute away and nothing is offered or withheld on the
      // strength of this one having run.
      this.logger.warn(
        `Could not close incomplete generations: ${error instanceof Error ? error.message : String(error)}.`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
