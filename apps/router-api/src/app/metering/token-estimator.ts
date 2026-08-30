/**
 * Fallback token counting for backends that answer without a `usage` block.
 *
 * A real BPE tokeniser would be exact, but it is model-specific and none of the
 * JavaScript ports is small: this is a documented approximation used only when
 * the upstream tells us nothing, and the `Generation` row it produces is the
 * router's best effort rather than a receipt from the model.
 *
 * The heuristic splits on word, number and punctuation runs — the units a BPE
 * vocabulary is built from — and charges one token per four characters of each
 * run, which is the ratio OpenAI documents for English text.
 */

const CHARS_PER_TOKEN = 4;
const RUNS = /[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]+/gu;

export function estimateTokens(text: string): number {
  let total = 0;
  for (const [run] of text.matchAll(RUNS)) {
    total += Math.ceil(run.length / CHARS_PER_TOKEN);
  }
  return total;
}

/** Per-message overhead OpenAI documents for the chat format (role + delimiters). */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Estimates the prompt size of an OpenAI-shaped request body.
 *
 * Reads `messages[].content` (chat), `prompt` (legacy completions) and `input`
 * (embeddings). The values are walked in memory and never stored — the router
 * has no column that could hold them (`data-model.md` invariant 1).
 */
export function estimatePromptTokens(body: Record<string, unknown>): number {
  const messages = body.messages;
  if (Array.isArray(messages)) {
    return messages.reduce<number>(
      (total, message) =>
        total + MESSAGE_OVERHEAD_TOKENS + estimateContent((message as Record<string, unknown>)?.content),
      0,
    );
  }
  return estimateContent(body.prompt) + estimateContent(body.input);
}

/**
 * Content is a string, an array of strings, or an array of content parts
 * (`{ type: 'text', text }`) — everything else (an image part, a tool call)
 * contributes nothing, which keeps the estimate low rather than invented.
 */
function estimateContent(content: unknown): number {
  if (typeof content === 'string') {
    return estimateTokens(content);
  }
  if (Array.isArray(content)) {
    return content.reduce<number>((total, part) => total + estimateContent(part), 0);
  }
  if (content && typeof content === 'object') {
    const text = (content as Record<string, unknown>).text;
    return typeof text === 'string' ? estimateTokens(text) : 0;
  }
  return 0;
}
