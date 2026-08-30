/**
 * Ported from Super-Protocol/swarm-cloud `libs/swarm-attestation/src/errors.ts`
 * (BSL-1.1) with permission; see the repository NOTICE.
 */
import type { VerifyErr, VerifyStage } from './types.js';

export function fail(stage: VerifyStage, reason: string): VerifyErr {
  return { ok: false, stage, reason };
}
