import { describe, expect, it } from 'vitest';
import { dataPayloadOf, formatDataEvent, SSE_DONE, SSE_HEARTBEAT, splitSseEvents } from './sse.js';

describe('splitSseEvents', () => {
  it('returns complete events and keeps the partial tail', () => {
    const { events, rest } = splitSseEvents('data: one\n\ndata: two\n\ndata: thr');

    expect(events).toEqual(['data: one\n\n', 'data: two\n\n']);
    expect(rest).toBe('data: thr');
  });

  it('yields nothing until an event is terminated', () => {
    expect(splitSseEvents('data: {"a":1}')).toEqual({ events: [], rest: 'data: {"a":1}' });
  });

  it('reassembles an event split across two reads', () => {
    const first = splitSseEvents('data: {"hel');
    const second = splitSseEvents(`${first.rest}lo":1}\n\n`);

    expect(second.events).toEqual(['data: {"hello":1}\n\n']);
    expect(second.rest).toBe('');
  });

  it('carries comment events through as events of their own', () => {
    const { events } = splitSseEvents(': ping\n\ndata: x\n\n');

    expect(events).toEqual([': ping\n\n', 'data: x\n\n']);
  });
});

describe('dataPayloadOf', () => {
  it('reads the payload with or without the conventional space', () => {
    expect(dataPayloadOf('data: {"a":1}\n\n')).toBe('{"a":1}');
    expect(dataPayloadOf('data:{"a":1}\n\n')).toBe('{"a":1}');
  });

  it('rejoins a multi-line payload as the SSE specification requires', () => {
    expect(dataPayloadOf('data: first\ndata: second\n\n')).toBe('first\nsecond');
  });

  it('is null for an event that carries no data line', () => {
    expect(dataPayloadOf(SSE_HEARTBEAT)).toBeNull();
    expect(dataPayloadOf('event: open\n\n')).toBeNull();
  });

  it('reads the stream terminator', () => {
    expect(dataPayloadOf(SSE_DONE)).toBe('[DONE]');
  });
});

describe('formatDataEvent', () => {
  it('round-trips through the parser', () => {
    const event = formatDataEvent('{"id":"gen-1"}');

    expect(event).toBe('data: {"id":"gen-1"}\n\n');
    expect(dataPayloadOf(event)).toBe('{"id":"gen-1"}');
  });
});
