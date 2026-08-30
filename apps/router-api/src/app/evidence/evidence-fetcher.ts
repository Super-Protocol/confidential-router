/**
 * Retrieval of a published evidence bundle. Retrieval only — see
 * `evidence-bundle.ts` for why nothing here verifies anything.
 */

export const EVIDENCE_PATH = '/.well-known/swarm-evidence';

/**
 * A published bundle is a few kilobytes of JSON (certificates and a JWS). The
 * cap is generous by two orders of magnitude and exists so a misbehaving or
 * hijacked evidence host cannot make the poller allocate without bound.
 */
export const MAX_BUNDLE_BYTES = 512 * 1024;

export class EvidenceFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceFetchError';
  }
}

export interface EvidenceSource {
  hostname: string;
  /**
   * Operator override for clusters where the public hostname does not resolve
   * from inside (`endpoints[].evidenceUrl`, ADR-002). The bundle it serves must
   * still name `hostname`, which is what keeps the override from becoming a way
   * to file one endpoint's evidence under another.
   */
  evidenceUrl?: string | null;
}

export interface FetchEvidenceOptions {
  timeoutMs?: number;
  fetcher?: typeof fetch;
  maxBytes?: number;
}

export function evidenceUrlFor(source: EvidenceSource): string {
  return source.evidenceUrl ?? `https://${source.hostname}${EVIDENCE_PATH}`;
}

/** Fetches and JSON-parses a bundle, or throws `EvidenceFetchError`. */
export async function fetchEvidenceBundle(
  source: EvidenceSource,
  options: FetchEvidenceOptions = {},
): Promise<unknown> {
  const url = evidenceUrlFor(source);
  const fetcher = options.fetcher ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? MAX_BUNDLE_BYTES;

  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      redirect: 'follow',
    });
  } catch (error) {
    throw new EvidenceFetchError(`GET ${url} failed: ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new EvidenceFetchError(`GET ${url} returned ${response.status}`);
  }

  const body = await readCapped(response, maxBytes, url);
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new EvidenceFetchError(`GET ${url} returned a body that is not JSON: ${(error as Error).message}`);
  }
}

/** Reads the body, aborting as soon as it exceeds the budget rather than after. */
async function readCapped(response: Response, maxBytes: number, url: string): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new EvidenceFetchError(`GET ${url} declared ${declared} bytes, over the ${maxBytes} byte budget`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new EvidenceFetchError(`GET ${url} exceeded the ${maxBytes} byte budget`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof EvidenceFetchError) throw error;
    throw new EvidenceFetchError(`GET ${url} failed while reading the body: ${(error as Error).message}`);
  }
  return Buffer.concat(chunks).toString('utf8');
}
