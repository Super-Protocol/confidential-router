import type { GenerationClient } from '../../db/entities/generation.entity.js';

/**
 * Which client sent a request, as a closed set — SUP-466.
 *
 * SUP-447 spent two days answering "which editor was the tester using?" from
 * screenshots, and the answer had been on the wire the whole time. This is that
 * answer, reduced to a label we are willing to keep.
 *
 * **The raw `User-Agent` never leaves this function.** It is a fingerprinting
 * vector, and this codebase already treats it as one — `InviteRedemption` keeps
 * only a salted `userAgentHash`, for abuse review. What comes out here is one of
 * the labels in {@link CLIENT_TABLE} or `other`: no version, no operating system,
 * no architecture, no editor build, no locale. There is deliberately no
 * `other_raw` escape hatch — that would be the raw agent string with extra steps.
 * A large `other` bucket is the signal to add a row to the table in a pull
 * request, and its size alone says that much.
 *
 * Nothing here reads the request body. "The request shape" extends exactly as far
 * as {@link ANNOUNCING_HEADERS} and no further: a label derived from the first
 * bytes of a system prompt would be a conclusion drawn from content, which is the
 * one thing the metering path does not do.
 */

/**
 * The headers a client announces *itself* in, as opposed to describing its
 * request.
 *
 * `user-agent` is the one that matters. The other two are OpenRouter conventions
 * that editors carry on every request, and they survive a `User-Agent` chosen by
 * the editor's HTTP stack rather than by the editor: Roo Code sends
 * `X-Title: Roo Code`, VS Code's own chat sends
 * `X-OnBehalf-Extension-Id: github.copilot-chat/<version>`.
 *
 * Nothing else is read. `HTTP-Referer` is deliberately absent even though those
 * same clients send it: Roo Code's value is `https://github.com/RooVetGit/Roo-Cline`,
 * which names the editor it was forked from rather than itself.
 */
const ANNOUNCING_HEADERS = ['user-agent', 'x-title', 'x-onbehalf-extension-id'] as const;

/** Enough of a header to classify by, bounded so a long one cannot cost anything. */
const MAX_HEADER_LENGTH = 200;

/**
 * The table people will argue with, which is why it is a table.
 *
 * Needles are matched against the announcement after {@link normalise} — lower
 * case with `-`, `_` and spaces removed — so one row covers `RooCode/3.54.0`,
 * `Roo-Code` and `X-Title: Roo Code` alike, and a client that re-spells itself
 * between releases does not need a new row.
 *
 * **The first row that matches wins**, so the order is part of the rule rather
 * than an accident of the loop:
 *
 * - `roo` before `cline`, because Roo Code is a Cline fork and still carries
 *   `Roo-Cline` in some of its strings. The other way round, Roo Code's traffic
 *   would be counted as Cline's.
 * - `langchain` and `litellm` before the two OpenAI SDKs, because both are
 *   wrappers around them: when they announce themselves at all, they do it in
 *   front of the SDK they are built on.
 *
 * Every needle is drawn from a string an actual client sent or ships.
 * `client-dimension.spec.ts` holds those strings and where each was captured —
 * including the two clients that announce nothing at all on an OpenAI-compatible
 * endpoint, which the spec names rather than leaving the reader to assume
 * coverage we do not have.
 */
const CLIENT_TABLE: readonly (readonly [needle: string, client: GenerationClient])[] = [
  ['copilot', 'vscode-chat'],
  ['roocode', 'roo'],
  ['cline', 'cline'],
  ['continue/', 'continue'],
  ['cursor/', 'cursor'],
  ['claudecli/', 'claude-code'],
  ['claudecode/', 'claude-code'],
  ['langchain', 'langchain'],
  ['litellm', 'litellm'],
  ['openai/python', 'openai-python'],
  ['openai/js', 'openai-node'],
  ['curl/', 'curl'],
];

/** Every value the column may hold: the table's labels, plus `other`. */
export const GENERATION_CLIENTS = [
  'vscode-chat',
  'cline',
  'roo',
  'continue',
  'cursor',
  'claude-code',
  'openai-python',
  'openai-node',
  'litellm',
  'langchain',
  'curl',
  'other',
] as const satisfies readonly GenerationClient[];

type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * The label for one request's headers; `other` for anything the table does not
 * name, a request whose `User-Agent` we do not recognise and a request that
 * carries none at all.
 *
 * `other` rather than null on purpose: null would read as "nobody looked", and
 * every row the gateway writes from here on has been looked at. The column is
 * nullable only because the rows written before SUP-466 were never classified.
 */
export function clientOf(headers: HeaderBag | undefined): GenerationClient {
  const announcement = announcementOf(headers);
  for (const [needle, client] of CLIENT_TABLE) {
    if (announcement.includes(needle)) {
      return client;
    }
  }
  return 'other';
}

/** The announcing headers as one normalised string, each bounded in length. */
function announcementOf(headers: HeaderBag | undefined): string {
  if (!headers) {
    return '';
  }
  const announced = ANNOUNCING_HEADERS.map((name) => {
    const value = headers[name];
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' ? first.slice(0, MAX_HEADER_LENGTH) : '';
  });
  // Joined with a separator that survives normalisation, so the tail of one
  // header and the head of the next cannot spell a needle between them.
  return normalise(announced.join('|'));
}

/** Lower case, with the separators clients spell their own names with removed. */
function normalise(announcement: string): string {
  return announcement.toLowerCase().replaceAll(/[-_\s]/g, '');
}
