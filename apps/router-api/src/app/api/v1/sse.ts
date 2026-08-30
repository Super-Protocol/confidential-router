/**
 * Just enough Server-Sent Events to proxy a chat completion stream.
 *
 * The router forwards chunks the moment they arrive — the only buffering is
 * within a single event, until its terminating blank line, because an event
 * cannot be rewritten before it is complete. Comments (`: ping`), `[DONE]` and
 * anything that is not JSON pass through untouched.
 */

export interface SseSplit {
  /** Complete events, each still carrying its terminating blank line. */
  events: string[];
  /** The partial tail, to be prepended to the next chunk. */
  rest: string;
}

const EVENT_SEPARATOR = '\n\n';

export function splitSseEvents(buffer: string): SseSplit {
  const events: string[] = [];
  let rest = buffer;
  let index = rest.indexOf(EVENT_SEPARATOR);
  while (index !== -1) {
    events.push(rest.slice(0, index + EVENT_SEPARATOR.length));
    rest = rest.slice(index + EVENT_SEPARATOR.length);
    index = rest.indexOf(EVENT_SEPARATOR);
  }
  return { events, rest };
}

/**
 * The `data:` payload of an event, with multi-line payloads rejoined as the
 * SSE specification requires. `null` for an event that carries none — a
 * heartbeat comment, or a bare `event:` line.
 */
export function dataPayloadOf(event: string): string | null {
  const lines = event.split('\n').filter((line) => line.startsWith('data:'));
  if (lines.length === 0) {
    return null;
  }
  return lines.map((line) => line.slice('data:'.length).replace(/^ /, '')).join('\n');
}

export function formatDataEvent(payload: string): string {
  return `data: ${payload}${EVENT_SEPARATOR}`;
}

/** The comment line the contract sends while waiting for the first token. */
export const SSE_HEARTBEAT = `: ping${EVENT_SEPARATOR}`;

export const SSE_DONE = formatDataEvent('[DONE]');
