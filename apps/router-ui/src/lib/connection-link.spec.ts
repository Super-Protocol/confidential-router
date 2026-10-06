import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type ConnectionLinkRefusal,
  connectionLinkRefusalMessage,
  parseConnectionLink,
  suggestedEndpointName,
} from './connection-link';

/**
 * The suite is the shared vector file, read rather than restated.
 *
 * `docs/contracts/connection-link-vectors.json` is what the producer side (the
 * stage-4 model-serving listings) is also tested against, so a format change
 * that lands in only one of the two implementations fails here.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const VECTORS_PATH = join(REPO_ROOT, 'docs/contracts/connection-link-vectors.json');

interface Vectors {
  version: number;
  accepted: { name: string; link: string; baseUrl: string; modelId: string; apiKey: string; suggestedName: string }[];
  refused: { name: string; link: string; reason: ConnectionLinkRefusal }[];
}

const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Vectors;

describe('the connection-link vector file', () => {
  it('is the version this parser implements', () => {
    expect(vectors.version).toBe(1);
  });

  // A vector file that lost its cases would make every test below vacuous.
  it('carries cases on both sides', () => {
    expect(vectors.accepted.length).toBeGreaterThan(5);
    expect(vectors.refused.length).toBeGreaterThan(5);
  });
});

describe('parseConnectionLink — accepted vectors', () => {
  for (const vector of vectors.accepted) {
    it(vector.name, () => {
      const result = parseConnectionLink(vector.link);
      if (!result.ok) throw new Error(`expected ${vector.link} to parse, got ${result.reason}`);

      expect(result.link).toEqual({
        baseUrl: vector.baseUrl,
        modelId: vector.modelId,
        apiKey: vector.apiKey,
        suggestedName: vector.suggestedName,
      });
    });
  }
});

describe('parseConnectionLink — refused vectors', () => {
  for (const vector of vectors.refused) {
    it(vector.name, () => {
      const result = parseConnectionLink(vector.link);
      if (result.ok) throw new Error(`expected ${vector.link} to be refused`);

      expect(result.reason).toBe(vector.reason);
    });
  }

  it('has a sentence for every refusal the parser can return', () => {
    const reasons = new Set(vectors.refused.map((vector) => vector.reason));
    for (const reason of reasons) {
      expect(connectionLinkRefusalMessage(reason)).toMatch(/\S/);
    }
  });

  /**
   * The one refusal worth stating twice: a key in the query string has been
   * logged by every hop that saw the request, so the message has to tell the
   * operator to rotate it rather than just "try again".
   */
  it('tells the operator to rotate a key that arrived in the query string', () => {
    expect(connectionLinkRefusalMessage('key_in_query')).toMatch(/rotate/i);
  });
});

describe('suggestedEndpointName', () => {
  it('keeps to the kebab-case shape the sidecar endpoint key requires', () => {
    expect(suggestedEndpointName('Qwen3-Coder.Swarm.Example')).toBe('qwen3-coder-swarm-example');
    expect(suggestedEndpointName('_weird__host_')).toBe('weird-host');
  });

  it('trims to the 64 characters the name column holds', () => {
    const name = suggestedEndpointName(`${'a'.repeat(80)}.example.com`);
    expect(name).toHaveLength(64);
  });
});
