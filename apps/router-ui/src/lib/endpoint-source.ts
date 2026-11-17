import {
  baseUrlOf,
  type ConnectionLink,
  connectionLinkRefusalMessage,
  parseConnectionLink,
  suggestedEndpointName,
} from './connection-link';

/**
 * What the admin pasted into the register dialog's one field (SUP-249).
 *
 * Two inputs are accepted and told apart by shape alone:
 *
 *  - a **connection link** — `https://host/v1#key=…&model=…`, emitted by a
 *    model deployment — fills everything, model included;
 *  - a **bare URL** — `https://host/v1` — is the start of discovery: the admin
 *    adds the key, the router attests the endpoint and then lists its models.
 *
 * A bare URL is exactly the link parser's `missing_fragment` refusal, so the
 * two share every other rule (https only, no key in the query string) and a
 * link that is malformed is still refused with the link's own sentence.
 */
export type EndpointSource =
  | { kind: 'empty' }
  | { kind: 'link'; link: ConnectionLink }
  | { kind: 'url'; baseUrl: string; suggestedName: string }
  | { kind: 'refused'; message: string /** Worth saying while the admin is still typing. */; urgent: boolean };

export function classifyEndpointSource(input: string): EndpointSource {
  const value = input.trim();
  if (value === '') return { kind: 'empty' };

  const parsed = parseConnectionLink(value);
  if (parsed.ok) return { kind: 'link', link: parsed.link };

  if (parsed.reason === 'missing_fragment') {
    const url = new URL(value);
    return { kind: 'url', baseUrl: baseUrlOf(url), suggestedName: suggestedEndpointName(url.hostname) };
  }
  if (parsed.reason === 'not_a_url') {
    return {
      kind: 'refused',
      message: 'Paste the endpoint’s https:// URL, or the whole connection link.',
      urgent: false,
    };
  }
  return { kind: 'refused', message: connectionLinkRefusalMessage(parsed.reason), urgent: true };
}
