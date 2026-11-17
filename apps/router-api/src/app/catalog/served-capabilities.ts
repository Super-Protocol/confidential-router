import type { ModelCapability } from '../db/entities/model.entity.js';

/**
 * What a catalogue row *declares*: which OpenAI route its upstream serves
 * itself. Three values, and they are the only ones an operator writes — in
 * `models[].capabilities` or in `ExternalModelInput.capabilities`.
 */
export type RouteCapability = ModelCapability;

/**
 * What the router *serves* for a model, which is what `GET /v1/models` and the
 * console report.
 *
 * A superset of the declared list, and deliberately a different type. Two of its
 * members are not routes at all — `tools` and `streaming` are things the `/v1`
 * surface does with a request — and one of them, `completions`, is served for a
 * chat-only model by translating the prompt (`api/v1/completions-bridge.ts`), so
 * "declared" and "served" were never the same list. Reporting the declared one
 * was what made `/v1/models` understate the model (SUP-450).
 */
export type ServedCapability = RouteCapability | 'tools' | 'streaming';

/**
 * The capability list for a model, derived from what it declares.
 *
 * Derived rather than stored, and that is the whole point: an operator cannot
 * declare a capability this router does not serve, and cannot forget to declare
 * one it does. The rules, each of them a property of the request path and not of
 * the model:
 *
 * - `chat` → the chat route. Also `completions`, because the gateway serves the
 *   legacy route for a chat model by wrapping the prompt in one user message.
 * - `completions` → the legacy route, forwarded verbatim to an upstream that
 *   serves it natively, which is what keeps `suffix` (infilling) working.
 *
 *   One value for two forms, so infilling is discoverable only by trying it and
 *   reading the 400. A derived `infilling` value — true exactly when
 *   `completions` is declared — is the consistent next step and deliberately
 *   not in this change (SUP-450 review).
 * - `embeddings` → the embeddings route.
 * - `tools` → `tools` / `tool_choice` are forwarded untouched and `tool_calls`
 *   deltas are relayed untouched, on any model with a chat route. It is a
 *   statement about this surface, not a promise that the model is good at
 *   choosing tools.
 *
 *   That is a deliberate trade and not a side effect of the derivation: a chat
 *   model with no tool-calling training now advertises `tools`, and a client
 *   that gates agent mode on the value will turn agent mode on. It is the
 *   opposite error from the one this function fixes. It is still the right one,
 *   because the alternative is the router judging a model it only forwards
 *   bytes to — and an operator-declared `tools` flag would be exactly the
 *   unverified assertion that produced the `["chat"]` understatement. A client
 *   that needs to know whether the model is any good at it has to try it.
 * - `streaming` → `stream: true` is honoured, which the gateway does on both
 *   generation routes and on neither embeddings one. Absent rather than false
 *   for embeddings: the route answers one JSON body whatever was asked for. Note
 *   it *ignores* `stream: true` there rather than refusing it — so this value
 *   says what gets honoured, which is the only reading that stays true.
 *
 * Order is canonical rather than the order the config happened to use, so two
 * models that serve the same things report the same list.
 */
export function servedCapabilities(declared: readonly RouteCapability[]): ServedCapability[] {
  const generates = declared.includes('chat') || declared.includes('completions');
  return [
    ...(declared.includes('chat') ? (['chat'] as const) : []),
    ...(generates ? (['completions'] as const) : []),
    ...(declared.includes('embeddings') ? (['embeddings'] as const) : []),
    ...(declared.includes('chat') ? (['tools'] as const) : []),
    ...(generates ? (['streaming'] as const) : []),
  ];
}

/**
 * Whether a request on `route` is served for a model that declares `declared`.
 *
 * The gateway's admission gate and `GET /v1/models` call this and
 * {@link servedCapabilities} respectively, and both read the same rules — which
 * is what makes the catalogue's answer and the route's answer impossible to
 * disagree about (`test/v1-completions.e2e.spec.ts` checks exactly that).
 */
export function servesRoute(declared: readonly RouteCapability[], route: RouteCapability): boolean {
  return servedCapabilities(declared).includes(route);
}

/**
 * Whether `POST /v1/completions` for this model is served by translating the
 * prompt into a chat request rather than by forwarding it.
 *
 * True exactly when the model has a chat route and did not declare the legacy
 * one. An upstream that declares both is forwarded natively, because a chat wrap
 * cannot do what the native route can: `suffix` infilling, and a prompt that
 * reaches the model without a chat template around it.
 */
export function bridgesCompletions(declared: readonly RouteCapability[]): boolean {
  return declared.includes('chat') && !declared.includes('completions');
}
