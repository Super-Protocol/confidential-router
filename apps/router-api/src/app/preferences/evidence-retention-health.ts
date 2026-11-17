import { Injectable } from '@nestjs/common';

/** What `/health` says about the evidence retention sweep. */
export interface EvidenceRetentionStatus {
  /** `enabled` while a sweep is scheduled; `disabled` when the interval is 0. */
  status: 'enabled' | 'disabled';
  /** When the last pass finished, or null if none has yet in this process. */
  lastSweepAt: string | null;
  /** Snapshots stripped since this process started. Monotonic; read it twice and subtract. */
  stripped: number;
  /** Passes that ended in an error since this process started. */
  failed: number;
}

/**
 * Whether the retention sweep is running, and what it has removed — the one
 * piece of sweep state that outlives a log line.
 *
 * The same object, under the same rule, as `AnalyticsHealth` (SUP-464) and
 * `MailService.status()` (SUP-269): a subsystem whose failure mode is silence
 * gets somewhere an operator can read it without the boot log. This one earns it
 * more than most — `evidenceRetentionDays` was published as a period and offered
 * as a console setting for the whole of the Private Preview while nothing read
 * it, and nothing in the running system could have said so.
 *
 * Deliberately process-lifetime state and no queries: `/health` is public and
 * unauthenticated, and a count of overdue rows would make every probe a table
 * scan a stranger could ask for. The durable record of what was removed is
 * `evidence_snapshots.payloadStrippedAt`, which is a database question for
 * whoever is authorised to ask it.
 */
@Injectable()
export class EvidenceRetentionHealth {
  private scheduled = false;
  private lastSweepAt: Date | null = null;
  private strippedTotal = 0;
  private failedPasses = 0;

  /** A sweep timer exists in this process. */
  sweepScheduled(): void {
    this.scheduled = true;
  }

  /** One pass finished, having stripped `stripped` snapshots. */
  passCompleted(stripped: number, at: Date): void {
    this.strippedTotal += stripped;
    this.lastSweepAt = at;
  }

  /** One pass threw. The timer survives it, so the count is what shows it happened. */
  passFailed(): void {
    this.failedPasses += 1;
  }

  status(): EvidenceRetentionStatus {
    return {
      status: this.scheduled ? 'enabled' : 'disabled',
      lastSweepAt: this.lastSweepAt?.toISOString() ?? null,
      stripped: this.strippedTotal,
      failed: this.failedPasses,
    };
  }
}
