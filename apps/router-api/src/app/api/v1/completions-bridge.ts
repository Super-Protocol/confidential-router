import { openAiErrors } from './openai-error.js';

/**
 * `POST /v1/completions` for a model whose upstream only serves chat (SUP-450).
 *
 * The legacy route used to answer `400 unsupported_parameter` for every
 * chat-only model, which is what the contract table calls a required path and
 * what a popular client reaches for without being asked: Continue prompts its
 * *apply* and *autocomplete* roles here, so a model configured for either got a
 * 400 per edit, retried, and eventually wedged the session (SUP-447, SUP-448).
 *
 * So the router serves the route itself: the prompt becomes one user message,
 * the answer becomes a `text_completion`. Everything between the two
 * translations — admission, metering, the SSE relay, the usage extension — is
 * the same code the chat route runs, because the translation is at the edges and
 * nothing in the middle is told about it.
 *
 * What it does *not* do is pretend to be the native route. Three legacy
 * parameters have no chat equivalent and are refused by name rather than dropped
 * in silence: dropping `suffix` would answer an infilling request with prose and
 * let a client paste it into the middle of a file. An upstream that serves
 * `/v1/completions` itself is declared with `capabilities: [chat, completions]`
 * and never reaches this file.
 */

/**
 * The legacy-only parameters a chat request cannot express: when each one counts
 * as asked for, and why it cannot be honoured.
 *
 * The predicates are there because the default value of three of them is a value
 * rather than an absence — a client that sends `echo: false`, `logprobs: 0` or
 * `best_of: 1` has asked for nothing and must not be refused for it.
 */
const UNTRANSLATABLE: { param: string; asked: (value: unknown) => boolean; because: string }[] = [
  {
    param: 'suffix',
    asked: (value) => typeof value === 'string' && value.length > 0,
    because: 'infilling needs the backend\'s own completions route; declare "completions" on the model to use it',
  },
  { param: 'echo', asked: (value) => value === true, because: 'the chat route cannot echo the prompt back' },
  {
    param: 'logprobs',
    asked: (value) => typeof value === 'number' && value > 0,
    because: 'the chat route reports log probabilities in a different shape',
  },
  {
    param: 'best_of',
    asked: (value) => typeof value === 'number' && value > 1,
    because: 'the router meters one completion per request',
  },
];

/**
 * The chat body for a legacy completions request.
 *
 * Everything the client sent is carried over — including fields this router has
 * never heard of, as on every other route — except the legacy-only ones, which
 * are either translated, refused, or dropped.
 *
 * Dropped is the third case and it is not an afterthought: a parameter that has
 * been checked and found to be asking for nothing must not survive the
 * translation. Three of the four have no chat equivalent at all and `logprobs`
 * has one of a different type (a boolean, not an integer), so forwarding
 * `suffix: ''` / `echo: false` / `logprobs: 0` / `best_of: 1` would hand the chat
 * route a body only a lenient upstream accepts — vLLM ignores unknown fields,
 * LiteLLM and the OpenAI API are entitled to answer 400. That would turn a
 * request this bridge decided to accept into an upstream error the client cannot
 * act on, and `suffix: ''` is exactly what an autocomplete client sends with the
 * cursor at end of file, so it is on the path this change exists to fix.
 */
export function chatBodyForPrompt(body: Record<string, unknown>): Record<string, unknown> {
  const prompt = promptTextOf(body.prompt);
  for (const { param, asked, because } of UNTRANSLATABLE) {
    if (asked(body[param])) {
      throw openAiErrors.unsupportedParameter(
        param,
        `"${param}" is not supported on /v1/completions for this model: ${because}.`,
      );
    }
  }

  const translated: Record<string, unknown> = { ...body, messages: [{ role: 'user', content: prompt }] };
  for (const key of ['prompt', ...UNTRANSLATABLE.map(({ param }) => param)]) {
    delete translated[key];
  }
  return translated;
}

/**
 * A whole `chat.completion` as a `text_completion`.
 *
 * `logprobs: null` is stated rather than omitted: the OpenAI schema has the key
 * on every legacy choice, and a client that reads it without checking is the
 * kind this bridge exists for.
 */
export function textCompletionOf(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    object: 'text_completion',
    choices: choicesOf(payload).map((choice, index) => ({
      index: typeof choice.index === 'number' ? choice.index : index,
      text: textOf(choice.message),
      logprobs: null,
      finish_reason: choice.finish_reason ?? null,
    })),
  };
}

/**
 * One streaming chunk, translated.
 *
 * A usage-only chunk — `choices` present and empty — keeps its empty list, which
 * is what the relay recognises when it drops the chunk it asked for on the
 * router's behalf.
 */
export function textCompletionChunkOf(chunk: Record<string, unknown>): Record<string, unknown> {
  return {
    ...chunk,
    object: 'text_completion',
    choices: choicesOf(chunk).map((choice, index) => ({
      index: typeof choice.index === 'number' ? choice.index : index,
      text: textOf(choice.delta),
      logprobs: null,
      finish_reason: choice.finish_reason ?? null,
    })),
  };
}

/**
 * The prompt as one string.
 *
 * A single-element array is the same request written the other way round and is
 * accepted as such. A batch of prompts and a pre-tokenised one are refused:
 * `n = 1` is already the rule on every route here, and the router holds no
 * tokeniser it could turn token ids back into text with.
 */
function promptTextOf(prompt: unknown): string {
  if (typeof prompt === 'string') {
    return prompt;
  }
  if (Array.isArray(prompt)) {
    if (prompt.length === 1 && typeof prompt[0] === 'string') {
      return prompt[0];
    }
    throw openAiErrors.unsupportedParameter(
      'prompt',
      prompt.every((entry) => typeof entry === 'string')
        ? 'Only one prompt per request is supported; the router meters one completion per request.'
        : 'A pre-tokenised prompt is not supported: send the text, not token ids.',
    );
  }
  throw openAiErrors.missingField('prompt');
}

function choicesOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  const choices = payload.choices;
  if (!Array.isArray(choices)) {
    return [];
  }
  return choices.map((choice) => (choice && typeof choice === 'object' ? (choice as Record<string, unknown>) : {}));
}

/** The assistant text of a message or a delta; anything else — a tool call, a refusal — is no text. */
function textOf(part: unknown): string {
  const content = part && typeof part === 'object' ? (part as Record<string, unknown>).content : undefined;
  return typeof content === 'string' ? content : '';
}
