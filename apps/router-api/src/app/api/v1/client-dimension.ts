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
 * as the headers below and no further: a label derived from the first bytes of a
 * system prompt would be a conclusion drawn from content, which is the one thing
 * the metering path does not do.
 */

/**
 * Headers whose value a client's own HTTP stack writes — a product string, not
 * free text — so a needle may match **anywhere inside** them.
 *
 * `user-agent` is the one that matters. `x-onbehalf-extension-id` is VS Code's,
 * not the caller's: it carries `github.copilot-chat/<version>` and survives an
 * agent string the editor's fetch chose rather than the editor itself.
 */
const PRODUCT_HEADERS = ['user-agent', 'x-onbehalf-extension-id'] as const;

/**
 * The OpenRouter-convention app name, which the **caller** picks.
 *
 * Matched only when the whole value *is* a label — `X-Title: Cline`,
 * `X-Title: Roo Code` — never as a substring. A substring rule here would read
 * `X-Title: Declined requests` as `cline` and `X-Title: My Copilot Dashboard` as
 * `vscode-chat`, and a wrong label is worse than an honest `other` by the same
 * argument that keeps the raw agent string out of the column. Taking the value at
 * face value when it names a client exactly is not a risk of the same kind: it is
 * what the caller told us it is.
 *
 * `HTTP-Referer` is deliberately absent even though these clients send it: Roo
 * Code's is `https://github.com/RooVetGit/Roo-Cline`, which names the editor it
 * was forked from rather than itself.
 */
const CALLER_TITLE_HEADER = 'x-title';

/** Enough of a header to classify by, bounded so a long one cannot cost anything. */
const MAX_HEADER_LENGTH = 200;

/**
 * The table people will argue with, which is why it is a table.
 *
 * Needles are matched after {@link normalise} — lower case with `-`, `_` and
 * spaces removed — so one row covers `RooCode/3.54.0`, `Roo-Code` and
 * `X-Title: Roo Code` alike, and a client that re-spells itself between releases
 * does not need a new row.
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
 * The needles are as narrow as the captured strings allow, because a label that
 * is wrong is worse than `other`. `copilotchat` rather than `copilot`: the first
 * row matching anything Copilot-shaped would file a future Copilot that is not
 * VS Code's chat under `vscode-chat` instead of leaving it in the bucket that
 * would have argued for its own row.
 *
 * Every needle is drawn from a string an actual client sent or ships.
 * `client-dimension.spec.ts` holds those strings and where each was captured —
 * including the clients that announce nothing at all on an OpenAI-compatible
 * endpoint, which it names rather than leaving the reader to assume coverage we
 * do not have.
 */
export const CLIENT_TABLE: readonly (readonly [needle: string, client: GenerationClient])[] = [
  ['copilotchat', 'vscode-chat'],
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
  // Joined with a separator that survives normalisation, so the tail of one
  // header and the head of the next cannot spell a needle between them.
  const product = PRODUCT_HEADERS.map((name) => headerValue(headers, name)).join('|');
  const title = headerValue(headers, CALLER_TITLE_HEADER);

  for (const [needle, client] of CLIENT_TABLE) {
    if (product.includes(needle) || title === needle) {
      return client;
    }
  }
  return 'other';
}

/** One header, normalised and bounded in length; `''` when it is not there. */
function headerValue(headers: HeaderBag | undefined, name: string): string {
  const value = headers?.[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? normalise(first.slice(0, MAX_HEADER_LENGTH)) : '';
}

/** Lower case, with the separators clients spell their own names with removed. */
function normalise(value: string): string {
  return value.toLowerCase().replaceAll(/[-_\s]/g, '');
}
