import { describe, expect, it } from 'vitest';
import { classifyEndpointSource } from './endpoint-source';

describe('classifyEndpointSource', () => {
  it('reads a connection link as the fast path, model and key included', () => {
    expect(classifyEndpointSource(' https://m.swarm.example/v1#key=sk-1&model=qwen ')).toEqual({
      kind: 'link',
      link: { baseUrl: 'https://m.swarm.example', apiKey: 'sk-1', modelId: 'qwen', suggestedName: 'm-swarm-example' },
    });
  });

  it('reads a bare URL as the start of discovery, without the /v1 surface', () => {
    expect(classifyEndpointSource('https://llama-3-2-3b.conf-apps.superprotocol.dev/v1')).toEqual({
      kind: 'url',
      baseUrl: 'https://llama-3-2-3b.conf-apps.superprotocol.dev',
      suggestedName: 'llama-3-2-3b-conf-apps-superprotocol-dev',
    });
  });

  it('keeps every link refusal: http, and a key in the query string', () => {
    expect(classifyEndpointSource('http://m.example/v1')).toMatchObject({ kind: 'refused', urgent: true });
    expect(classifyEndpointSource('https://m.example/v1?api_key=sk')).toMatchObject({
      kind: 'refused',
      urgent: true,
      message: expect.stringMatching(/rotate it upstream/),
    });
    expect(classifyEndpointSource('https://m.example/v1#key=sk')).toMatchObject({ kind: 'refused', urgent: true });
  });

  it('does not shout at a half-typed URL', () => {
    expect(classifyEndpointSource('https:')).toMatchObject({ kind: 'refused', urgent: false });
    expect(classifyEndpointSource('   ')).toEqual({ kind: 'empty' });
  });
});
