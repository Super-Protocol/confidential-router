import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { redact } from './redact.js';

const REDACT_PATHS = ['req.headers.authorization', 'req.headers.cookie', "res.headers['set-cookie']"];

export const REQUEST_ID_HEADER = 'x-request-id';

export interface PinoHttpConfigOptions {
  level: string;
  sensitiveKeys?: string[];
  /**
   * Paths whose automatic request/response lines are suppressed — health probes,
   * typically, which would otherwise be most of the log.
   *
   * They are silenced rather than excluded from the middleware, so they still
   * get a request id and still log anything the handler itself reports.
   */
  quietPathPrefixes?: string[];
}

/**
 * `nestjs-pino` options shared by the app and its tests. The request id is
 * generated here rather than in a separate middleware so that pino-http's own
 * `req.id` — the one that ends up on every automatic request/response line — is
 * the same value the response header carries back to the caller.
 *
 * Deliberately no `transport`: pino's transports run in a worker thread loaded
 * from a path on disk, which does not survive being bundled into a single file.
 * A caller that wants pretty output passes a `pino-pretty` stream alongside
 * these options instead.
 */
export function createPinoHttpConfig(options: PinoHttpConfigOptions) {
  const { level, sensitiveKeys, quietPathPrefixes = [] } = options;

  return {
    level,
    genReqId: (req: IncomingMessage, res: ServerResponse): string => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      const requestId = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
      res.setHeader(REQUEST_ID_HEADER, requestId);
      return requestId;
    },
    autoLogging:
      quietPathPrefixes.length === 0
        ? true
        : {
            ignore: (req: IncomingMessage) => quietPathPrefixes.some((prefix) => (req.url ?? '').startsWith(prefix)),
          },
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    formatters: {
      log: (object: Record<string, unknown>) => redact(object, sensitiveKeys) as Record<string, unknown>,
    },
    customProps: (req: IncomingMessage) => ({ requestId: (req as { id?: string }).id }),
  };
}
