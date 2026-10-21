import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { clientOf, GENERATION_CLIENTS } from './client-dimension.js';

/**
 * The mapping table, with the strings that produced it.
 *
 * **Every agent string below was captured from a running client, not written
 * from memory.** Where it came from matters more than that it passes, because
 * the table is the part of SUP-466 people will argue with, and an invented
 * `User-Agent` is an argument nobody can settle. Provenance, per group:
 *
 * - **SUP-447's wire recording** — code-server 4.141.0 / VS Code 1.141.0 driven
 *   headlessly against production through a logging proxy, 97 real agent
 *   requests. That run is where `GitHubCopilotChat/0.69.0`, `RooCode/3.54.0`,
 *   `OpenAI/JS 5.23.2`, `curl/8.5.0`, `node` and `axios/1.20.0` come from.
 * - **The shipped extension bundles** from the same rig, for the two strings
 *   those editors send only to their own routing providers and never reached the
 *   proxy: Cline 4.1.25's `Cline/SDK` and Continue 2.0.0's `Continue/IDE`.
 * - **Captured for this issue** against a local header-logging server:
 *   `OpenAI/Python 3.35.1`, `OpenAI/JS 7.39.0`, `litellm/1.106.2`,
 *   `langchainjs-openai/1.0.0 …` and `claude-cli/2.1.291 (external, sdk-cli)`
 *   from Claude Code 2.1.291.
 * - **`Cursor/1.0`** is the one value we have not captured ourselves: Cursor
 *   calls an overridden base URL from its own backend rather than from the
 *   editor, so it cannot be driven from a laptop. The string is the one Cursor's
 *   documented behaviour and third-party proxy reports agree on, and it is the
 *   row to re-confirm the first time a real Cursor request lands.
 */

/** One real string per supported client, and where each was captured. */
const CAPTURED = [
  { client: 'vscode-chat', ua: 'GitHubCopilotChat/0.69.0', from: "VS Code 1.141.0's own chat, SUP-447" },
  { client: 'cline', ua: 'Cline/SDK', from: 'Cline 4.1.25 bundle, provider default headers' },
  { client: 'roo', ua: 'RooCode/3.54.0', from: 'Roo Code 3.54.0, SUP-447' },
  { client: 'continue', ua: 'Continue/IDE', from: 'Continue 2.0.0 bundle, ClawRouter provider' },
  { client: 'cursor', ua: 'Cursor/1.0', from: 'Cursor, reported — not captured by us' },
  { client: 'claude-code', ua: 'claude-cli/2.1.291 (external, sdk-cli)', from: 'Claude Code 2.1.291' },
  { client: 'openai-python', ua: 'OpenAI/Python 3.35.1', from: 'openai 3.35.1 for Python' },
  { client: 'openai-node', ua: 'OpenAI/JS 5.23.2', from: 'Continue 2.0.0 over openai-node, SUP-447' },
  { client: 'litellm', ua: 'litellm/1.106.2', from: 'litellm 1.106.2, its own HTTP handler' },
  {
    client: 'langchain',
    ua: 'langchainjs-openai/1.0.0 ((node/v22.23.2; linux; x64))',
    from: '@langchain/openai 1.7.x',
  },
  { client: 'curl', ua: 'curl/8.5.0', from: 'curl 8.5.0, SUP-447' },
] as const;

describe('the client mapping', () => {
  for (const { client, ua, from } of CAPTURED) {
    it(`maps ${client} — ${from}`, () => {
      expect(clientOf({ 'user-agent': ua })).toBe(client);
    });
  }

  it('maps a later version of the same client to the same label', () => {
    // No version string ever reaches the column, so a client that bumps its own
    // version must not start a second series in every breakdown.
    expect(clientOf({ 'user-agent': 'OpenAI/JS 7.39.0' })).toBe('openai-node');
    expect(clientOf({ 'user-agent': 'OpenAI/Python 2.54.0' })).toBe('openai-python');
    expect(clientOf({ 'user-agent': 'RooCode/9.0.0-beta.1' })).toBe('roo');
  });

  it('reads a client that names itself in a header other than the agent string', () => {
    // Roo Code and VS Code's chat both carry these on every request, and they
    // survive an agent string chosen by the HTTP stack rather than the editor.
    expect(clientOf({ 'user-agent': 'node', 'x-title': 'Roo Code' })).toBe('roo');
    expect(clientOf({ 'user-agent': 'node', 'x-onbehalf-extension-id': 'github.copilot-chat/0.69.0' })).toBe(
      'vscode-chat',
    );
  });

  it('counts Roo Code as Roo Code even though it still calls itself a Cline fork', () => {
    // `RooCode/3.54.0` arrives beside `HTTP-Referer: https://github.com/RooVetGit/Roo-Cline`.
    // Matching `cline` first would file every Roo Code request under the editor
    // it was forked from — which is why the table's order is the rule.
    expect(clientOf({ 'user-agent': 'RooCode/3.54.0', 'x-title': 'Roo Code' })).toBe('roo');
  });

  it('counts a wrapper as the wrapper, not as the SDK underneath it', () => {
    expect(clientOf({ 'user-agent': 'langchainjs-openai/1.0.0 ((node/v22.23.2; linux; x64))' })).toBe('langchain');
    expect(clientOf({ 'user-agent': 'litellm/1.106.2' })).toBe('litellm');
  });

  it('maps an unknown agent string to other', () => {
    expect(clientOf({ 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' })).toBe('other');
    expect(clientOf({ 'user-agent': 'SomeoneElsesAgent/4.2' })).toBe('other');
  });

  it('maps the two clients that announce nothing to other, which is the honest answer', () => {
    // Captured from Cline 4.1.25 against an OpenAI-compatible endpoint: the
    // extension names neither itself nor its editor. Guessing from the system
    // prompt would be a conclusion drawn from content, so `other` it is, and the
    // size of that bucket is what argues for a better signal.
    expect(clientOf({ 'user-agent': 'node' })).toBe('other');
    expect(
      clientOf({
        'user-agent': 'ai-sdk/openai-compatible/3.0.58 ai-sdk/provider-utils/5.0.50 runtime/node.js/v24.21.0',
      }),
    ).toBe('other');
    expect(clientOf({ 'user-agent': 'axios/1.20.0' })).toBe('other');
  });

  it('does not throw on an absent agent string, or on absent headers', () => {
    expect(clientOf({})).toBe('other');
    expect(clientOf(undefined)).toBe('other');
    expect(clientOf({ 'user-agent': undefined })).toBe('other');
    expect(clientOf({ 'user-agent': '' })).toBe('other');
  });

  it('reads the first value of a repeated header rather than failing on the array', () => {
    expect(clientOf({ 'user-agent': ['curl/8.5.0', 'curl/8.5.0'] })).toBe('curl');
  });

  it('never returns anything outside the closed set, whatever it is handed', () => {
    const hostile = [
      'x'.repeat(10_000),
      '\u0000\u0001\u0002',
      '../../etc/passwd',
      'OpenAI/Python 3.35.1; DROP TABLE generations',
      '🙂',
    ];
    for (const ua of hostile) {
      expect(GENERATION_CLIENTS).toContain(clientOf({ 'user-agent': ua }));
    }
  });

  it('returns no part of the agent string it was given', () => {
    // The point of the dimension: the fingerprint is read and discarded in one
    // place, and nothing a caller receives carries a version, an OS or a build.
    const ua = 'OpenAI/Python 3.35.1 (Linux; x86_64; CPython 3.12.3; en-GB)';
    const label: string = clientOf({ 'user-agent': ua });

    expect(label).toBe('openai-python');
    for (const fingerprint of ['3.35.1', 'Linux', 'x86_64', 'CPython', 'en-GB']) {
      expect(label).not.toContain(fingerprint);
    }
  });

  it('declares every label the table can produce, and no label it cannot', () => {
    // `GENERATION_CLIENTS` is what the taxonomy's enum and the entity's union are
    // checked against; a label reachable from the table but missing here would be
    // a value the analytics allow-list silently drops.
    const produced = new Set(CAPTURED.map((entry) => entry.client as string));
    produced.add('other');

    expect([...GENERATION_CLIENTS].sort()).toEqual([...produced].sort());
  });

  it('says the same thing as the taxonomy, which is the allow-list with teeth', () => {
    // `AnalyticsService.declaredProperties` drops an undeclared property and logs
    // it; a set that drifted apart here would not fail a request, it would quietly
    // produce a `first_request_sent` with no client on it.
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, '..', '..', '..', '..', '..', '..');
    const taxonomy = JSON.parse(readFileSync(join(repoRoot, 'schemas', 'analytics-taxonomy.json'), 'utf8')) as {
      events: { name: string; properties?: Record<string, { enum?: string[] }> }[];
    };
    const declared = taxonomy.events.find((event) => event.name === 'first_request_sent')?.properties?.client;

    expect(declared?.enum?.slice().sort()).toEqual([...GENERATION_CLIENTS].sort());
  });
});
